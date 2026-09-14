import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { 
  getWalletBalance, 
  getWalletTransactions, 
  requestWithdrawal,
  createDepositIntent,
  parseMinorUnits
} from './service.js';
import { PaystackGateway } from '../payment/PaystackGateway.js';
import { FlutterwaveGateway } from '../payment/FlutterwaveGateway.js';
import prisma from '../../utils/db.js';
import { parsePagination } from '../../utils/pagination.js';

export const walletRouter = express.Router();

const paystackGateway = new PaystackGateway();
const flutterwaveGateway = new FlutterwaveGateway();

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

    // 1. Persist the server-owned intent BEFORE any checkout is exposed. The
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

    const request = await requestWithdrawal(userId, amountMinorUnits, idempotencyKey);

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
    if (error.name === 'InvalidAmountError' || error.name === 'InvalidIdempotencyKeyError') {
      return res.status(400).json({ error: error.message });
    }
    if (['EligibilityRequiredError', 'CountryNotAllowedError', 'AgeNotVerifiedError', 'KycRequiredError'].includes(error.name)) {
      return res.status(403).json({ error: error.message });
    }
    next(error);
  }
});
