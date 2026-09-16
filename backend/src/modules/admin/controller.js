import express from 'express';
import prisma from '../../utils/db.js';
import { requireAuth } from '../../middleware/auth.js';
import { AuthService } from '../auth/service.js';
import { getIO } from '../../sockets/index.js';
import logger from '../../utils/logger.js';
import { PaystackGateway } from '../payment/PaystackGateway.js';
import { FlutterwaveGateway } from '../payment/FlutterwaveGateway.js';
import {
  WithdrawalService,
  WithdrawalNotFoundError,
  WithdrawalStateError
} from '../withdrawal/service.js';
import { parsePagination } from '../../utils/pagination.js';

export const adminRouter = express.Router();

const withdrawalService = new WithdrawalService({
  providers: { PAYSTACK: new PaystackGateway(), FLUTTERWAVE: new FlutterwaveGateway() }
});

adminRouter.use(requireAuth);

// Only admin accounts may touch account status.
adminRouter.use((req, res, next) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Admin privileges required' });
  }
  next();
});

const REVOCATION_MESSAGES = {
  ban: 'Account suspended',
  unban: 'Account reinstated'
};

async function setStatus(req, res, next, banned) {
  try {
    const targetId = req.params.userId;
    const target = await prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, isBanned: true }
    });
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = await AuthService.setAccountStatus(targetId, banned);

    // Disconnect any live sockets so a banned session stops emitting and
    // stops receiving the account's events. Socket.IO may not be
    // initialized in HTTP-only/test environments; that must not fail the ban.
    if (banned) {
      try {
        getIO().in(`user:${targetId}`).disconnectSockets(true);
      } catch (_) {
        // Socket layer not running; the DB flag + refresh revocation still hold.
      }
      logger.info({ adminId: req.user.id, targetId }, 'User banned');
    } else {
      logger.info({ adminId: req.user.id, targetId }, 'User unbanned');
    }

    res.json({ user, message: REVOCATION_MESSAGES[banned ? 'ban' : 'unban'] });
  } catch (err) {
    next(err);
  }
}

adminRouter.patch('/users/:userId/ban', async (req, res, next) => {
  await setStatus(req, res, next, true);
});

adminRouter.patch('/users/:userId/unban', async (req, res, next) => {
  await setStatus(req, res, next, false);
});

// ---------------------------------------------------------------------------
// Withdrawal V2 review + payout actions
// ---------------------------------------------------------------------------

adminRouter.get('/withdrawals', async (req, res, next) => {
  try {
    const parsed = parsePagination(req.query);
    if (!parsed.ok) {
      return res.status(400).json({ error: 'Invalid pagination params' });
    }
    const { page, limit } = parsed.data;
    const { status } = req.query;
    const data = await withdrawalService.listAllWithdrawals({
      page,
      limit,
      ...(typeof status === 'string' && WITHDRAWAL_STATUS_LIST.includes(status) ? { status } : {})
    });
    res.json(data);
  } catch (error) {
    next(error);
  }
});

const WITHDRAWAL_STATUS_LIST = ['PENDING_REVIEW', 'APPROVED', 'PROCESSING', 'COMPLETED', 'FAILED', 'RELEASED'];

adminRouter.post('/withdrawals/:id/approve', async (req, res, next) => {
  try {
    const row = await withdrawalService.approveWithdrawal(req.params.id, req.user.id);
    res.json({ withdrawal: row });
  } catch (error) {
    next(error);
  }
});

adminRouter.post('/withdrawals/:id/begin-payout', async (req, res, next) => {
  try {
    const row = await withdrawalService.beginPayout(req.params.id);
    res.json({ withdrawal: row });
  } catch (error) {
    next(error);
  }
});

adminRouter.post('/withdrawals/:id/report-result', async (req, res, next) => {
  try {
    const { success, failureReason } = req.body;
    if (typeof success !== 'boolean') {
      return res.status(400).json({ error: 'success must be a boolean' });
    }
    const row = await withdrawalService.reportPayoutResult(req.params.id, { success, failureReason });
    res.json({ withdrawal: row });
  } catch (error) {
    next(error);
  }
});

adminRouter.post('/withdrawals/:id/reject', async (req, res, next) => {
  try {
    const row = await withdrawalService.rejectWithdrawal(req.params.id, req.user.id, req.body?.reason);
    // Funds returned to the player — push the refreshed balance over the socket
    // (the durable wallet.updated outbox row was written inside the release tx).
    try {
      getIO().to(`user:${row.userId}`).emit('wallet_updated', {
        balanceChange: `+${row.amountMinorUnits}`,
        type: 'WITHDRAWAL_RELEASE',
        withdrawalId: row.id
      });
    } catch (e) {
      logger.warn({ e, withdrawalId: row.id }, 'Failed to emit socket event after withdrawal release');
    }
    res.json({ withdrawal: row });
  } catch (error) {
    next(error);
  }
});