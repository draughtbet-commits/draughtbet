import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireIdempotencyKey } from '../../middleware/idempotency.js';
import { WithdrawalService } from './service.js';
import { PaystackGateway } from '../payment/PaystackGateway.js';
import { FlutterwaveGateway } from '../payment/FlutterwaveGateway.js';
import {
  BankAccountRequiredError,
  BankAccountNotFoundError,
  BankAccountNotVerifiedError
} from './service.js';
import { InsufficientFundsError } from '../../services/matchService.js';

export const withdrawalUserRouter = express.Router();

const paystackGateway = new PaystackGateway();
const flutterwaveGateway = new FlutterwaveGateway();
export const withdrawalService = new WithdrawalService({
  providers: { PAYSTACK: paystackGateway, FLUTTERWAVE: flutterwaveGateway }
});

const withdrawalPayload = (w) => ({
  id: w.id,
  userId: w.userId,
  amountMinorUnits: w.amountMinorUnits?.toString?.() ?? w.amountMinorUnits,
  currency: w.currency,
  reference: w.reference,
  gateway: w.gateway,
  status: w.status,
  bankAccountId: w.bankAccountId,
  providerRef: w.providerRef,
  reviewedBy: w.reviewedBy,
  reviewedAt: w.reviewedAt,
  processedAt: w.processedAt,
  failureReason: w.failureReason,
  createdAt: w.createdAt,
  updatedAt: w.updatedAt
});

// Contract §6 POST /withdrawals — request a payout to a verified destination.
// Reserves the funds immediately (PENDING_REVIEW) and replays idempotently.
withdrawalUserRouter.post('/', requireAuth, requireIdempotencyKey({ scope: 'withdrawal' }), async (req, res, next) => {
  try {
    const { amountMinor, bankAccountId } = req.body ?? {};
    const withdrawal = await withdrawalService.requestWithdrawal(
      req.user.id,
      amountMinor,
      req.get('idempotency-key'),
      bankAccountId
    );
    res.status(201).json({ data: { withdrawal: withdrawalPayload(withdrawal) } });
  } catch (error) {
    if (error?.name === 'InvalidAmountError') {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    if (error instanceof BankAccountRequiredError || error instanceof BankAccountNotVerifiedError) {
      return res.status(422).json({ error: error.message });
    }
    if (error instanceof BankAccountNotFoundError) {
      return res.status(404).json({ error: { code: 'BANK_ACCOUNT_NOT_FOUND', message: error.message } });
    }
    if (error instanceof InsufficientFundsError) {
      return res.status(402).json({ error: error.message });
    }
    next(error);
  }
});

// Contract §6 GET /withdrawals/{withdrawalId} — single withdrawal state for
// the owning player only. Mounted at /api/v1/withdrawals in app.js.
withdrawalUserRouter.get('/:withdrawalId', requireAuth, async (req, res, next) => {
  try {
    const withdrawal = await withdrawalService.getWithdrawal(req.user.id, req.params.withdrawalId);
    if (!withdrawal) {
      return res.status(404).json({ error: { code: 'WITHDRAWAL_NOT_FOUND', message: 'Withdrawal not found' } });
    }
    res.json({
      withdrawal: withdrawalPayload(withdrawal)
    });
  } catch (error) {
    next(error);
  }
});