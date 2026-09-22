import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { 
  getWalletBalance, 
  getWalletTransactions, 
  createDepositIntent,
  parseMinorUnits
} from './service.js';
import { PaystackGateway } from '../payment/PaystackGateway.js';
import { FlutterwaveGateway } from '../payment/FlutterwaveGateway.js';
import { WithdrawalService, BankAccountNotFoundError } from '../withdrawal/service.js';
import { PaymentGatewayError } from '../payment/PaymentGateway.js';
import { EligibilityService } from '../eligibility/service.js';
import prisma from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { parsePagination } from '../../utils/pagination.js';

export const walletRouter = express.Router();

const paystackGateway = new PaystackGateway();
const flutterwaveGateway = new FlutterwaveGateway();
const withdrawalService = new WithdrawalService({
  providers: { PAYSTACK: paystackGateway, FLUTTERWAVE: flutterwaveGateway }
});
const eligibilityService = new EligibilityService();

walletRouter.get('/balance', requireAuth, async (req, res, next) => {
  try {
    const { id: userId } = req.user;
    const balance = await getWalletBalance(userId);
    if (!balance) {
      return res.status(404).json({ error: 'Wallet not found' });
    }
    res.json({ balance });
  } catch (error) {
    next(error);
  }
});

walletRouter.get('/transactions', requireAuth, async (req, res, next) => {
  try {
    const { id: userId } = req.user;
    const parsed = parsePagination(req.query);
    if (!parsed.ok) {
      return res.status(400).json({ error: 'Invalid pagination params' });
    }
    const { page, limit } = parsed.data;

    const data = await getWalletTransactions(userId, page, limit);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

walletRouter.get('/tier-limits', requireAuth, async (req, res, next) => {
  try {
    const { tier } = req.user;
    const settings = await prisma.platformSettings.findUnique({
      where: { id: 'singleton' }
    });
    
    if (!settings) {
      return res.status(500).json({ error: 'Platform settings not configured' });
    }

    let minP, maxP, calloutMaxP;
    switch (tier) {
      case 'MASTER':
        minP = settings.masterStakeMinP;
        maxP = settings.masterStakeMaxP;
        calloutMaxP = settings.masterCalloutMaxP;
        break;
      case 'PRO':
        minP = settings.proStakeMinP;
        maxP = settings.proStakeMaxP;
        calloutMaxP = settings.proCalloutMaxP;
        break;
      case 'AMATEUR':
      default:
        minP = settings.amateurStakeMinP;
        maxP = settings.amateurStakeMaxP;
        calloutMaxP = settings.amateurCalloutMaxP;
        break;
    }

    res.json({
      tier,
      stakeMin: minP.toString(),
      stakeMax: maxP.toString(),
      calloutMax: calloutMaxP.toString()
    });
  } catch (error) {
    next(error);
  }
});

walletRouter.post('/deposit-intent', requireAuth, async (req, res, next) => {
  let intent;
  try {
    const { id: userId, email } = req.user; // requireAuth populates id and email from DB
    const { amountMinorUnits, gateway } = req.body;
    
    const amount = parseMinorUnits(amountMinorUnits);
    if (amount === null) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    let gatewayKey;
    if (gateway === 'paystack') {
      gatewayKey = 'PAYSTACK';
    } else if (gateway === 'flutterwave') {
      gatewayKey = 'FLUTTERWAVE';
    } else {
      return res.status(400).json({ error: 'Invalid gateway specified' });
    }

    // 1. Eligibility + safer-play gates decide before the server owns an
    //    intent: account state, self-exclusion, and the rolling 24h deposit
    //    limit are enforced server-side across every device.
    await eligibilityService.canDeposit(userId, amount);

    // 2. Persist the server-owned intent BEFORE any checkout is exposed. The
    //    webhook can then only be authorized against this record, and the
    //    amount/currency/wallet are never taken from the raw webhook body.
    intent = await createDepositIntent(userId, amount, gatewayKey, email || 'user@example.com');

    // 2. Initiate at the provider with OUR reference, so the webhook echoes it.
    const gatewayImpl = gatewayKey === 'PAYSTACK' ? paystackGateway : flutterwaveGateway;
    const { authorizationUrl, reference } = await gatewayImpl.initiatePayment(
      intent.amountMinorUnits,
      userId,
      email || 'user@example.com',
      intent.reference
    );

    // 3. Reference echoed back must be the intent's (the ledger idempotency
    //    and webhook verification both key off it).
    await prisma.depositIntent.update({
      where: { id: intent.id },
      data: { authorizationUrl }
    });

    res.json({ authorizationUrl, reference });
  } catch (error) {
    if (error.name === 'PaymentGatewayError') {
      // Provider init failed — the intent was persisted but no checkout was
      // exposed. Mark only that intent FAILED so it can never be credited by
      // a stray webhook (other PENDING intents of this user stay untouched).
      if (typeof intent !== 'undefined') {
        try {
          await prisma.depositIntent.update({
            where: { id: intent.id },
            data: { status: 'FAILED' }
          });
        } catch (markErr) {
          // Best-effort; the webhook layer still requires a matching intent.
        }
      }
      // Specifically catch the Gateway Error and surface a clear message to the client
      return res.status(503).json({ error: error.message });
    }
    const status = EligibilityService.statusCode(error);
    if (status !== 500) {
      return res.status(status).json({ error: error.message });
    }
    next(error);
  }
});

walletRouter.post('/withdrawal-request', requireAuth, async (req, res, next) => {
  try {
    const { id: userId } = req.user;
    const { amountMinorUnits, idempotencyKey } = req.body;

    // Enforced canonically by the service (parseMinorUnits); this fast-path
    // check mirrors it for malformed junk.
    if (amountMinorUnits === undefined || amountMinorUnits === null) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const request = await withdrawalService.requestWithdrawal(userId, amountMinorUnits, idempotencyKey);

    res.status(201).json({
      withdrawalRequest: {
        ...request,
        amountMinorUnits: request.amountMinorUnits.toString()
      }
    });
  } catch (error) {
    if (error.name === 'InsufficientFundsError') {
      return res.status(402).json({ error: error.message });
    }
    if (['InvalidAmountError', 'InvalidIdempotencyKeyError'].includes(error.name)) {
      return res.status(400).json({ error: error.message });
    }
    if (['BankAccountRequiredError', 'BankAccountNotVerifiedError', 'BankAccountNotFoundError'].includes(error.name)) {
      return res.status(422).json({ error: error.message });
    }
    if (['EligibilityRequiredError', 'CountryNotAllowedError', 'AgeNotVerifiedError', 'KycRequiredError', 'AccountRestrictedError', 'SelfExcludedError'].includes(error.name)) {
      return res.status(403).json({ error: error.message });
    }
    next(error);
  }
});

walletRouter.get('/withdrawals', requireAuth, async (req, res, next) => {
  try {
    const { id: userId } = req.user;
    const parsed = parsePagination(req.query);
    if (!parsed.ok) return res.status(400).json({ error: 'Invalid pagination params' });
    const { page, limit } = parsed.data;
    const { status } = req.query;
    const data = await withdrawalService.listWithdrawals(userId, {
      page,
      limit,
      ...(typeof status === 'string' && status ? { status } : {})
    });
    res.json(data);
  } catch (error) {
    next(error);
  }
});

walletRouter.get('/bank-accounts', requireAuth, async (req, res, next) => {
  try {
    const { id: userId } = req.user;
    const accounts = await withdrawalService.listBankAccounts(userId);
    res.json({ bankAccounts: accounts });
  } catch (error) {
    next(error);
  }
});

walletRouter.post('/bank-accounts', requireAuth, async (req, res, next) => {
  try {
    const { id: userId } = req.user;
    const { gateway, bankCode, bankName, accountNumber } = req.body;
    let normalizedGateway;
    if (gateway === 'paystack' || gateway === 'PAYSTACK') normalizedGateway = 'PAYSTACK';
    else if (gateway === 'flutterwave' || gateway === 'FLUTTERWAVE') normalizedGateway = 'FLUTTERWAVE';
    else return res.status(400).json({ error: 'Invalid gateway' });

    const account = await withdrawalService.createBankAccount(userId, {
      gateway: normalizedGateway,
      bankCode,
      bankName,
      accountNumber
    });

    res.status(201).json({
      bankAccount: {
        id: account.id,
        gateway: account.gateway,
        bankCode: account.bankCode,
        bankName: account.bankName,
        accountNumber: account.accountNumber,
        accountName: account.accountName,
        isDefault: account.isDefault,
        verifiedAt: account.verifiedAt,
        createdAt: account.createdAt
      }
    });
  } catch (error) {
    if (error.name === 'InvalidBankAccountError') {
      return res.status(400).json({ error: error.message });
    }
    if (error instanceof PaymentGatewayError) {
      return res.status(422).json({ error: error.message });
    }
    next(error);
  }
});

walletRouter.patch('/bank-accounts/:id/default', requireAuth, async (req, res, next) => {
  try {
    const { id: userId } = req.user;
    const account = await withdrawalService.setDefaultBankAccount(userId, req.params.id);
    res.json({ bankAccount: account });
  } catch (error) {
    if (error instanceof BankAccountNotFoundError) {
      return res.status(404).json({ error: error.message });
    }
    next(error);
  }
});

walletRouter.delete('/bank-accounts/:id', requireAuth, async (req, res, next) => {
  try {
    const { id: userId } = req.user;
    await withdrawalService.deleteBankAccount(userId, req.params.id);
    res.json({ deleted: true });
  } catch (error) {
    if (error instanceof BankAccountNotFoundError) {
      return res.status(404).json({ error: error.message });
    }
    next(error);
  }
});
