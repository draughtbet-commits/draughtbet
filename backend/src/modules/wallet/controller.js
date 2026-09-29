import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { 
  getWalletBalance, 
  getWalletTransactions, 
  createDepositIntent,
  findDepositIntentByClientKey,
  getDepositIntent,
  createDepositQuote,
  findDepositQuoteByClientKey,
  depositQuotePayload,
  DepositQuoteError,
  parseMinorUnits,
  parseIdempotencyKey
} from './service.js';
import { PaystackGateway } from '../payment/PaystackGateway.js';
import { FlutterwaveGateway } from '../payment/FlutterwaveGateway.js';
import {
  WithdrawalService,
  BankAccountNotFoundError,
  toPlayerBankAccount
} from '../withdrawal/service.js';
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

// Client errors on a quote are policy or input faults, not server faults, so
// they get real status codes instead of collapsing into a 500.
const depositQuoteStatus = (code) => {
  switch (code) {
    case 'INVALID_AMOUNT':
    case 'AMOUNT_OUT_OF_RANGE':
      return 400;
    case 'QUOTE_NOT_FOUND':
      return 404;
    case 'QUOTE_ALREADY_USED':
    case 'QUOTE_EXPIRED':
    case 'QUOTE_AMOUNT_MISMATCH':
    case 'QUOTE_METHOD_UNAVAILABLE':
      return 409;
    case 'UNSUPPORTED_CURRENCY':
      return 422;
    case 'NO_GATEWAY_AVAILABLE':
    case 'FEE_SCHEDULE_NOT_ACTIVE':
    case 'POLICY_UNAVAILABLE':
      return 503;
    default:
      return 500;
  }
};

/**
 * POST /api/v1/wallet/deposit-quote
 *
 * The single source of truth for a deposit's amount, fee, total, currency and
 * the set of available payment gateways. The client must never invent any of
 * them — before this route existed the deposit flow had no way to render a fee
 * or a gateway list that the server would honour.
 *
 * Honours an Idempotency-Key exactly like the intent create: a replayed quote
 * request returns the original quote, never a second one.
 */
walletRouter.post('/deposit-quote', requireAuth, async (req, res, next) => {
  try {
    const { id: userId } = req.user;
    const { amountMinorUnits } = req.body ?? {};

    let clientKey;
    try {
      clientKey = parseIdempotencyKey(req.get('idempotency-key'));
    } catch (keyErr) {
      return res.status(400).json({ error: { code: 'INVALID_IDEMPOTENCY_KEY', message: keyErr.message } });
    }

    // Replay lookup BEFORE the amount/policy gates so a retry that would now
    // fail a gate still resolves to the quote the client already holds.
    if (clientKey) {
      const replay = await findDepositQuoteByClientKey(userId, clientKey);
      if (replay) {
        return res.json({ quote: depositQuotePayload(replay), replayed: true });
      }
    }

    let result;
    try {
      result = await createDepositQuote(userId, amountMinorUnits, clientKey);
    } catch (createErr) {
      // A concurrent request with the same client key won the create.
      if (createErr?.code === 'P2002' && clientKey) {
        const existing = await findDepositQuoteByClientKey(userId, clientKey);
        if (existing) {
          return res.json({ quote: depositQuotePayload(existing), replayed: true });
        }
      }
      throw createErr;
    }

    res.json({ quote: depositQuotePayload(result.quote), replayed: result.replayed });
  } catch (error) {
    if (error instanceof DepositQuoteError) {
      const status = depositQuoteStatus(error.code);
      if (status !== 500) {
        return res.status(status).json({ error: { code: error.code, message: error.message } });
      }
      logger.error({ err: error }, 'Deposit quote failed unexpectedly');
    }
    next(error);
  }
});

walletRouter.post('/deposit-intent', requireAuth, async (req, res, next) => {
  let intent;
  try {
    const { id: userId, email } = req.user; // requireAuth populates id and email from DB
    const { amountMinorUnits, gateway, quoteId } = req.body;
    
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

    // A quoteId is optional for backwards compatibility, but when the client
    // quoted first the server re-validates and consumes that quote instead of
    // taking the amount on trust — see createDepositIntent/claimDepositQuote.
    const quoteRef = typeof quoteId === 'string' && quoteId.trim() ? quoteId.trim() : null;

    // Client idempotency (decision §39): a replayed checkout returns the
    // original intent — no second provider checkout is ever opened. The
    // lookup runs BEFORE the eligibility gate so a replay that would now fail
    // eligibility still resolves to the intent the client already has.
    let clientKey;
    try {
      clientKey = parseIdempotencyKey(req.get('idempotency-key'));
    } catch (keyErr) {
      return res.status(400).json({ error: { code: 'INVALID_IDEMPOTENCY_KEY', message: keyErr.message } });
    }
    if (clientKey) {
      const replay = await findDepositIntentByClientKey(userId, clientKey);
      if (replay) {
        return res.json({
          authorizationUrl: replay.authorizationUrl,
          reference: replay.reference,
          replayed: true
        });
      }
    }

    // 1. Eligibility + safer-play gates decide before the server owns an
    //    intent: account state, self-exclusion, and the rolling 24h deposit
    //    limit are enforced server-side across every device.
    await eligibilityService.canDeposit(userId, amount);

    // 2. Persist the server-owned intent BEFORE any checkout is exposed. The
    //    webhook can then only be authorized against this record, and the
    //    amount/currency/wallet are never taken from the raw webhook body.
    try {
      intent = await createDepositIntent(userId, amount, gatewayKey, email || 'user@example.com', clientKey, quoteRef);
    } catch (createErr) {
      // A concurrent request with the same client key won the create — resolve
      // the original intent instead of failing the retry.
      if (createErr?.code === 'P2002' && clientKey) {
        const existing = await findDepositIntentByClientKey(userId, clientKey);
        if (existing) {
          return res.json({
            authorizationUrl: existing.authorizationUrl,
            reference: existing.reference,
            replayed: true
          });
        }
      }
      throw createErr;
    }

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
    // A quote that cannot be honoured is a client-visible conflict (expired,
    // already used, amount drifted) — the client must re-quote, not see a 500.
    if (error instanceof DepositQuoteError) {
      const status = depositQuoteStatus(error.code);
      if (status !== 500) {
        return res.status(status).json({ error: { code: error.code, message: error.message } });
      }
    }
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

// REMOVED: POST /wallet/withdrawal-request.
//
// This duplicate of the contract route let a client create a withdrawal with a
// body `idempotencyKey`, no `bankAccountId`, and a `withdrawalRequest` response
// key, entirely bypassing contract §6 (POST /withdrawals, `Idempotency-Key`
// header, required verified destination). Two ways to move money out of the
// platform is two ways to get it wrong, and this one was the weaker of the
// pair. Use POST /withdrawals.

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

    res.status(201).json({ bankAccount: toPlayerBankAccount(account) });
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
    res.json({ bankAccount: toPlayerBankAccount(account) });
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

// ---------------------------------------------------------------------------
// Contract §6: GET /deposits/{depositId} — single deposit state, owner only.
// Mounted at /api/v1/deposits in app.js.
// ---------------------------------------------------------------------------
export const depositsRouter = express.Router();

const depositPayload = (d) => ({
  id: d.id,
  gateway: d.gateway,
  reference: d.reference,
  amountMinorUnits: d.amountMinorUnits.toString(),
  currency: d.currency,
  status: d.status,
  authorizationUrl: d.authorizationUrl ?? null,
  appliedAt: d.appliedAt ?? null,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt
});

depositsRouter.get('/:depositId', requireAuth, async (req, res, next) => {
  try {
    const intent = await getDepositIntent(req.user.id, req.params.depositId);
    if (!intent) {
      return res.status(404).json({ error: { code: 'DEPOSIT_NOT_FOUND', message: 'Deposit not found' } });
    }
    res.json({ deposit: depositPayload(intent) });
  } catch (error) {
    next(error);
  }
});
