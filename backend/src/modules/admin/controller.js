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
import { parseMinorUnits } from '../wallet/service.js';
import {
  PERMISSIONS,
  ADMIN_ROLES,
  ROLE_DESCRIPTIONS,
  roleHasPermission
} from '../rbac/permissions.js';
import {
  requirePermission,
  requireAdminMfa,
  assignRole,
  revokeRole,
  getUserRoles
} from '../rbac/service.js';
import { recordAdminAction } from '../audit/service.js';
import { auditRouter } from '../audit/controller.js';
import {
  listVerificationCases,
  approveVerificationCase,
  rejectVerificationCase,
  VerificationCaseNotFoundError,
  VerificationCaseNotReviewableError,
  KYC_STATUSES
} from '../verification/service.js';
import { clearTimeoutByAdmin, endSelfExclusionByAdmin } from '../saferPlay/service.js';
import { AdminService } from './service.js';
import { InsufficientFundsError, InvalidAmountError } from '../../services/ledgerService.js';

export const adminRouter = express.Router();

const withdrawalService = new WithdrawalService({
  providers: { PAYSTACK: new PaystackGateway(), FLUTTERWAVE: new FlutterwaveGateway() }
});

adminRouter.use(requireAuth);
adminRouter.use(requireAdminMfa);
adminRouter.use('/audit', auditRouter);

// Helper to write the audit row for a completed admin action.
const audit = (req, action, { targetType = null, targetId = null, metadata = null, outcome = 'SUCCESS' } = {}) =>
  recordAdminAction({
    adminId: req.user.id,
    action,
    outcome,
    targetType,
    targetId,
    metadata,
    ip: req.ip,
    userAgent: req.get('user-agent'),
    requestId: req.id
  }).catch((err) => logger.warn({ err, action }, 'Failed to write admin audit row'));

// ---------------------------------------------------------------------------
// Account status (SUPPORT / SUPER_ADMIN)
// ---------------------------------------------------------------------------

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
    }

    await audit(req, banned ? 'user.ban' : 'user.unban', {
      targetType: 'user',
      targetId,
      metadata: { action: banned ? 'ban' : 'unban' }
    });

    res.json({ user, message: REVOCATION_MESSAGES[banned ? 'ban' : 'unban'] });
  } catch (err) {
    next(err);
  }
}

adminRouter.patch(
  '/users/:userId/ban',
  requirePermission(PERMISSIONS.USERS_MANAGE),
  async (req, res, next) => {
    await setStatus(req, res, next, true);
  }
);

adminRouter.patch(
  '/users/:userId/unban',
  requirePermission(PERMISSIONS.USERS_MANAGE),
  async (req, res, next) => {
    await setStatus(req, res, next, false);
  }
);

// ---------------------------------------------------------------------------
// Withdrawal V2 review + payout actions (FINANCE / SUPER_ADMIN)
// ---------------------------------------------------------------------------

const WITHDRAWAL_STATUS_LIST = ['PENDING_REVIEW', 'APPROVED', 'PROCESSING', 'COMPLETED', 'FAILED', 'RELEASED'];

adminRouter.get(
  '/withdrawals',
  requirePermission(PERMISSIONS.WITHDRAWALS_READ),
  async (req, res, next) => {
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
  }
);

adminRouter.post(
  '/withdrawals/:id/approve',
  requirePermission(PERMISSIONS.WITHDRAWALS_PROCESS),
  async (req, res, next) => {
    try {
      const row = await withdrawalService.approveWithdrawal(req.params.id, req.user.id);
      await audit(req, 'withdrawal.approve', { targetType: 'withdrawal', targetId: row.id });
      res.json({ withdrawal: row });
    } catch (error) {
      if (error.name === 'WithdrawalNotFoundError') return res.status(404).json({ error: error.message });
      if (error.name === 'WithdrawalStateError') return res.status(409).json({ error: error.message });
      next(error);
    }
  }
);

adminRouter.post(
  '/withdrawals/:id/begin-payout',
  requirePermission(PERMISSIONS.WITHDRAWALS_PROCESS),
  async (req, res, next) => {
    try {
      const row = await withdrawalService.beginPayout(req.params.id);
      await audit(req, 'withdrawal.begin-payout', { targetType: 'withdrawal', targetId: row.id });
      res.json({ withdrawal: row });
    } catch (error) {
      if (error.name === 'WithdrawalNotFoundError') return res.status(404).json({ error: error.message });
      if (error.name === 'WithdrawalStateError') return res.status(409).json({ error: error.message });
      if (error.name === 'BankAccountRequiredError' || error.name === 'PaymentGatewayError') {
        return res.status(422).json({ error: error.message });
      }
      next(error);
    }
  }
);

adminRouter.post(
  '/withdrawals/:id/report-result',
  requirePermission(PERMISSIONS.WITHDRAWALS_PROCESS),
  async (req, res, next) => {
    try {
      const { success, failureReason } = req.body;
      if (typeof success !== 'boolean') {
        return res.status(400).json({ error: 'success must be a boolean' });
      }
      const row = await withdrawalService.reportPayoutResult(req.params.id, { success, failureReason });
      await audit(req, success ? 'withdrawal.report-success' : 'withdrawal.report-failure', {
        targetType: 'withdrawal',
        targetId: row.id,
        metadata: { success, failureReason: failureReason ?? null }
      });
      res.json({ withdrawal: row });
    } catch (error) {
      if (error.name === 'WithdrawalNotFoundError') return res.status(404).json({ error: error.message });
      if (error.name === 'WithdrawalStateError') return res.status(409).json({ error: error.message });
      next(error);
    }
  }
);

adminRouter.post(
  '/withdrawals/:id/reject',
  requirePermission(PERMISSIONS.WITHDRAWALS_PROCESS),
  async (req, res, next) => {
    try {
      const row = await withdrawalService.rejectWithdrawal(req.params.id, req.user.id, req.body?.reason);
      await audit(req, 'withdrawal.reject', {
        targetType: 'withdrawal',
        targetId: row.id,
        metadata: { reason: req.body?.reason ?? null }
      });
      res.json({ withdrawal: row });
    } catch (error) {
      if (error.name === 'WithdrawalNotFoundError') return res.status(404).json({ error: error.message });
      if (error.name === 'WithdrawalStateError') return res.status(409).json({ error: error.message });
      next(error);
    }
  }
);

// ---------------------------------------------------------------------------
// Roles (SUPER_ADMIN only)
// ---------------------------------------------------------------------------

adminRouter.get(
  '/roles',
  requirePermission(PERMISSIONS.ROLES_ADMIN),
  async (_req, res, next) => {
    try {
      const assignments = await prisma.adminRoleAssignment.groupBy({
        by: ['roleId'],
        _count: { _all: true }
      });
      const counts = Object.fromEntries(assignments.map((a) => [a.roleId, a._count._all]));
      const roles = ADMIN_ROLES.map((name) => ({
        name,
        description: ROLE_DESCRIPTIONS[name],
        permissions: Object.values(PERMISSIONS).filter((p) => roleHasPermission(name, p)),
        assignedCount: counts[name] ?? 0
      }));
      res.json({ roles });
    } catch (error) {
      next(error);
    }
  }
);

adminRouter.get(
  '/users/:userId/roles',
  requirePermission(PERMISSIONS.ROLES_ADMIN),
  async (req, res, next) => {
    try {
      const target = await prisma.user.findUnique({ where: { id: req.params.userId } });
      if (!target) return res.status(404).json({ error: 'User not found' });
      const assignments = await getUserRoles(req.params.userId);
      res.json({
        userId: req.params.userId,
        roles: assignments.map((a) => ({ name: a.role.name, assignedAt: a.assignedAt }))
      });
    } catch (error) {
      next(error);
    }
  }
);

const requireTargetUser = async (req, res, next) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.body?.userId } });
    if (!target) return res.status(404).json({ error: 'User not found' });
    next();
  } catch (error) {
    next(error);
  }
};

adminRouter.post(
  '/roles/assign',
  requirePermission(PERMISSIONS.ROLES_ADMIN),
  requireTargetUser,
  async (req, res, next) => {
    try {
      const { userId, roleName } = req.body;
      const assignment = await assignRole(userId, roleName, { assignedBy: req.user.id });
      await audit(req, 'role.assign', {
        targetType: 'user',
        targetId: userId,
        metadata: { roleName }
      });
      res.status(201).json({ roleName, assignment });
    } catch (error) {
      if (error.name === 'RoleAssignmentError') return res.status(400).json({ error: error.message });
      next(error);
    }
  }
);

adminRouter.post(
  '/roles/revoke',
  requirePermission(PERMISSIONS.ROLES_ADMIN),
  requireTargetUser,
  async (req, res, next) => {
    try {
      const { userId, roleName } = req.body;
      const result = await revokeRole(userId, roleName, { assignedBy: req.user.id });
      await audit(req, 'role.revoke', {
        targetType: 'user',
        targetId: userId,
        metadata: { roleName }
      });
      res.json({ roleName, revoked: result?.count ?? 0 });
    } catch (error) {
      if (error.name === 'RoleAssignmentError') return res.status(400).json({ error: error.message });
      next(error);
    }
  }
);

// ---------------------------------------------------------------------------
// KYC review (RISK_COMPLIANCE / SUPER_ADMIN)
// ---------------------------------------------------------------------------

adminRouter.get(
  '/verification-cases',
  requirePermission(PERMISSIONS.VERIFICATION_REVIEW),
  async (req, res, next) => {
    try {
      const parsed = parsePagination(req.query);
      if (!parsed.ok) return res.status(400).json({ error: 'Invalid pagination params' });
      const { page, limit } = parsed.data;
      const { status } = req.query;
      const filtered = typeof status === 'string' && KYC_STATUSES.includes(status) ? status : null;
      const data = await listVerificationCases({ page, limit, status: filtered });
      res.json(data);
    } catch (error) {
      next(error);
    }
  }
);

adminRouter.post(
  '/verification-cases/:id/approve',
  requirePermission(PERMISSIONS.VERIFICATION_REVIEW),
  async (req, res, next) => {
    try {
      const { case: verificationCase, replayed } = await approveVerificationCase(req.params.id, {
        adminId: req.user.id,
        note: req.body?.note ?? null
      });
      await audit(req, 'verification.approve', {
        targetType: 'verification-case',
        targetId: verificationCase.id,
        metadata: { replayed, verifiedById: req.user.id }
      });
      res.json({ verificationCase, replayed });
    } catch (error) {
      if (error.name === 'VerificationCaseNotFoundError') return res.status(404).json({ error: error.message });
      if (error.name === 'VerificationCaseNotReviewableError') return res.status(409).json({ error: error.message });
      next(error);
    }
  }
);

adminRouter.post(
  '/verification-cases/:id/reject',
  requirePermission(PERMISSIONS.VERIFICATION_REVIEW),
  async (req, res, next) => {
    try {
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'Rejected by operator';
      const { case: verificationCase, replayed } = await rejectVerificationCase(req.params.id, {
        adminId: req.user.id,
        reason
      });
      await audit(req, 'verification.reject', {
        targetType: 'verification-case',
        targetId: verificationCase.id,
        metadata: { replayed, reason }
      });
      res.json({ verificationCase, replayed });
    } catch (error) {
      if (error.name === 'VerificationCaseNotFoundError') return res.status(404).json({ error: error.message });
      if (error.name === 'VerificationCaseNotReviewableError') return res.status(409).json({ error: error.message });
      next(error);
    }
  }
);

// ---------------------------------------------------------------------------
// Disputes (SUPPORT / SUPER_ADMIN)
// ---------------------------------------------------------------------------

const DISPUTE_STATUS_LIST = ['OPEN', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED'];
const DISPUTE_EVIDENCE_TYPES = ['SCREENSHOT', 'CHAT_LOG', 'GAME_LOG', 'SYSTEM_LOG', 'OTHER'];

adminRouter.get(
  '/disputes',
  requirePermission(PERMISSIONS.DISPUTES_MANAGE),
  async (req, res, next) => {
    try {
      const parsed = parsePagination(req.query);
      if (!parsed.ok) return res.status(400).json({ error: 'Invalid pagination params' });
      const { page, limit } = parsed.data;
      const { status } = req.query;
      const where =
        typeof status === 'string' && DISPUTE_STATUS_LIST.includes(status) ? { status } : {};
      const skip = (page - 1) * limit;
      const [rows, total] = await Promise.all([
        prisma.disputeCase.findMany({
          where,
          orderBy: { updatedAt: 'desc' },
          skip,
          take: limit,
          include: {
            evidence: { orderBy: { uploadedAt: 'asc' } },
            match: { select: { id: true, status: true, outcome: true } }
          }
        }),
        prisma.disputeCase.count({ where })
      ]);
      const raisedBy = [...new Set(rows.map((r) => r.raisedBy))];
      const raisers = raisedBy.length
        ? await prisma.user.findMany({
            where: { id: { in: raisedBy } },
            select: { id: true, email: true }
          })
        : [];
      const emailByUser = Object.fromEntries(raisers.map((u) => [u.id, u.email]));
      const disputes = rows.map((r) => ({
        ...r,
        raisedByEmail: emailByUser[r.raisedBy] ?? null
      }));
      res.json({ disputes, total, page, totalPages: Math.ceil(total / limit) });
    } catch (error) {
      next(error);
    }
  }
);

adminRouter.post(
  '/disputes/:id/evidence',
  requirePermission(PERMISSIONS.DISPUTES_MANAGE),
  async (req, res, next) => {
    try {
      const { type, url, description } = req.body ?? {};
      if (!DISPUTE_EVIDENCE_TYPES.includes(type)) {
        return res.status(400).json({ error: 'Invalid evidence type' });
      }
      if (typeof url !== 'string' || url.trim() === '') {
        return res.status(400).json({ error: 'Evidence url is required' });
      }
      const existing = await prisma.disputeCase.findUnique({ where: { id: req.params.id } });
      if (!existing) return res.status(404).json({ error: 'Dispute case not found' });
      const evidence = await prisma.disputeEvidence.create({
        data: {
          caseId: req.params.id,
          type,
          url: url.trim(),
          ...(typeof description === 'string' ? { description } : {})
        }
      });
      await audit(req, 'dispute.evidence', {
        targetType: 'dispute',
        targetId: req.params.id,
        metadata: { evidenceId: evidence.id, type }
      });
      res.status(201).json({ evidence });
    } catch (error) {
      next(error);
    }
  }
);

adminRouter.post(
  '/disputes/:id/decide',
  requirePermission(PERMISSIONS.DISPUTES_MANAGE),
  async (req, res, next) => {
    try {
      const { status, resolution } = req.body ?? {};
      if (!['RESOLVED', 'DISMISSED'].includes(status)) {
        return res.status(400).json({ error: 'status must be RESOLVED or DISMISSED' });
      }
      if (typeof resolution !== 'string' || resolution.trim() === '') {
        return res.status(400).json({ error: 'resolution is required' });
      }
      const existing = await prisma.disputeCase.findUnique({ where: { id: req.params.id } });
      if (!existing) return res.status(404).json({ error: 'Dispute case not found' });
      if (!['OPEN', 'UNDER_REVIEW'].includes(existing.status)) {
        return res.status(409).json({ error: 'Dispute is already decided' });
      }
      const decided = await prisma.disputeCase.update({
        where: { id: req.params.id },
        data: {
          status,
          resolution: resolution.trim(),
          decidedBy: req.user.id,
          decidedAt: new Date()
        }
      });
      await audit(req, 'dispute.decide', {
        targetType: 'dispute',
        targetId: req.params.id,
        metadata: { status, resolution: resolution.trim() }
      });
      res.json({ disputeCase: decided });
    } catch (error) {
      next(error);
    }
  }
);

// ---------------------------------------------------------------------------
// Risk (RISK_COMPLIANCE / SUPER_ADMIN)
// ---------------------------------------------------------------------------

const RISK_CASE_STATUS_LIST = ['OPEN', 'INVESTIGATING', 'RESOLVED', 'DISMISSED'];

adminRouter.get(
  '/risk-events',
  requirePermission(PERMISSIONS.RISK_REVIEW),
  async (req, res, next) => {
    try {
      const parsed = parsePagination(req.query);
      if (!parsed.ok) return res.status(400).json({ error: 'Invalid pagination params' });
      const { page, limit } = parsed.data;
      const { type, severity, userId } = req.query;
      const where = {
        ...(typeof userId === 'string' ? { userId } : {}),
        ...(typeof type === 'string' ? { type } : {}),
        ...(typeof severity === 'string' ? { severity } : {})
      };
      const skip = (page - 1) * limit;
      const [rows, total] = await Promise.all([
        prisma.riskEvent.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
        prisma.riskEvent.count({ where })
      ]);
      res.json({ events: rows, total, page, totalPages: Math.ceil(total / limit) });
    } catch (error) {
      next(error);
    }
  }
);

adminRouter.get(
  '/risk-cases',
  requirePermission(PERMISSIONS.RISK_REVIEW),
  async (req, res, next) => {
    try {
      const parsed = parsePagination(req.query);
      if (!parsed.ok) return res.status(400).json({ error: 'Invalid pagination params' });
      const { page, limit } = parsed.data;
      const { status } = req.query;
      const where =
        typeof status === 'string' && RISK_CASE_STATUS_LIST.includes(status) ? { status } : {};
      const skip = (page - 1) * limit;
      const [rows, total] = await Promise.all([
        prisma.riskCase.findMany({ where, orderBy: { updatedAt: 'desc' }, skip, take: limit }),
        prisma.riskCase.count({ where })
      ]);
      res.json({ cases: rows, total, page, totalPages: Math.ceil(total / limit) });
    } catch (error) {
      next(error);
    }
  }
);

adminRouter.post(
  '/risk-cases/:id/status',
  requirePermission(PERMISSIONS.RISK_REVIEW),
  async (req, res, next) => {
    try {
      const { status, assignedTo } = req.body ?? {};
      if (!RISK_CASE_STATUS_LIST.includes(status)) {
        return res.status(400).json({ error: 'Invalid risk case status' });
      }
      const existing = await prisma.riskCase.findUnique({ where: { id: req.params.id } });
      if (!existing) return res.status(404).json({ error: 'Risk case not found' });
      const updated = await prisma.riskCase.update({
        where: { id: req.params.id },
        data: {
          status,
          ...(typeof assignedTo === 'string' ? { assignedTo } : {})
        }
      });
      await audit(req, 'risk-case.status', {
        targetType: 'risk-case',
        targetId: req.params.id,
        metadata: { status, assignedTo: typeof assignedTo === 'string' ? assignedTo : null }
      });
      res.json({ riskCase: updated });
    } catch (error) {
      next(error);
    }
  }
);

// ---------------------------------------------------------------------------
// Ledger adjustments (FINANCE / SUPER_ADMIN)
// ---------------------------------------------------------------------------

adminRouter.post(
  '/ledger/adjustments',
  requirePermission(PERMISSIONS.LEDGER_ADJUST),
  async (req, res, next) => {
    try {
      const { userId, amountMinorUnits, direction, reason, reference } = req.body ?? {};
      if (!userId || !reference || typeof reference !== 'string' || reference.trim() === '') {
        return res.status(400).json({ error: 'userId and reference are required' });
      }
      if (!['CREDIT', 'DEBIT'].includes(direction)) {
        return res.status(400).json({ error: 'direction must be CREDIT or DEBIT' });
      }
      const amount = parseMinorUnits(amountMinorUnits);
      if (amount === null || amount === 0n) {
        return res.status(400).json({ error: 'amountMinorUnits must be a positive minor-unit string' });
      }

      const target = await prisma.user.findUnique({ where: { id: userId } });
      if (!target) return res.status(404).json({ error: 'User not found' });

      const result = await AdminService.postAdjustment({
        userId,
        amountMinorUnits: amount,
        direction,
        reason: typeof reason === 'string' ? reason : null,
        reference: reference.trim(),
        actorId: req.user.id
      });
      await audit(req, 'ledger.adjustment', {
        targetType: 'user',
        targetId: userId,
        metadata: {
          direction,
          amountMinorUnits: amount.toString(),
          reference: reference.trim(),
          transactionId: result.transactionId
        }
      });
      res.status(201).json({ adjustment: result });
    } catch (error) {
      if (error.name === 'InvalidAmountError') return res.status(400).json({ error: error.message });
      if (error.name === 'InsufficientFundsError') return res.status(422).json({ error: error.message });
      next(error);
    }
  }
);

// ---------------------------------------------------------------------------
// Safer-play lifts (RISK_COMPLIANCE / SUPPORT / SUPER_ADMIN)
// ---------------------------------------------------------------------------

adminRouter.post(
  '/safer-play/:userId/clear-timeout',
  requirePermission(PERMISSIONS.SAFER_PLAY_LIFT),
  async (req, res, next) => {
    try {
      const target = await prisma.user.findUnique({ where: { id: req.params.userId } });
      if (!target) return res.status(404).json({ error: 'User not found' });
      const profile = await clearTimeoutByAdmin(req.params.userId, { actorId: req.user.id });
      await audit(req, 'safer-play.clear-timeout', {
        targetType: 'user',
        targetId: req.params.userId,
        metadata: { lifted: Boolean(profile) }
      });
      res.json({ lifted: Boolean(profile), profile });
    } catch (error) {
      next(error);
    }
  }
);

adminRouter.post(
  '/safer-play/:userId/end-self-exclusion',
  requirePermission(PERMISSIONS.SAFER_PLAY_LIFT),
  async (req, res, next) => {
    try {
      const target = await prisma.user.findUnique({ where: { id: req.params.userId } });
      if (!target) return res.status(404).json({ error: 'User not found' });
      const profile = await endSelfExclusionByAdmin(req.params.userId, { actorId: req.user.id });
      await audit(req, 'safer-play.end-self-exclusion', {
        targetType: 'user',
        targetId: req.params.userId,
        metadata: { lifted: Boolean(profile) }
      });
      res.json({ lifted: Boolean(profile), profile });
    } catch (error) {
      next(error);
    }
  }
);