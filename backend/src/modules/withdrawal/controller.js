import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { WithdrawalService } from './service.js';
import { PaystackGateway } from '../payment/PaystackGateway.js';
import { FlutterwaveGateway } from '../payment/FlutterwaveGateway.js';

export const withdrawalUserRouter = express.Router();

const paystackGateway = new PaystackGateway();
const flutterwaveGateway = new FlutterwaveGateway();
const withdrawalService = new WithdrawalService({
  providers: { PAYSTACK: paystackGateway, FLUTTERWAVE: flutterwaveGateway }
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
      withdrawal: {
        id: withdrawal.id,
        amountMinorUnits: withdrawal.amountMinorUnits.toString(),
        currency: withdrawal.currency,
        reference: withdrawal.reference,
        gateway: withdrawal.gateway,
        status: withdrawal.status,
        bankAccountId: withdrawal.bankAccountId,
        providerRef: withdrawal.providerRef,
        reviewedBy: withdrawal.reviewedBy,
        reviewedAt: withdrawal.reviewedAt,
        processedAt: withdrawal.processedAt,
        failureReason: withdrawal.failureReason,
        createdAt: withdrawal.createdAt,
        updatedAt: withdrawal.updatedAt
      }
    });
  } catch (error) {
    next(error);
  }
});