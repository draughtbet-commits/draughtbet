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
import { AdminMfaService } from '../mfa/service.js';
import { adminMfaRateLimiter } from '../../middleware/rateLimit.js';
import { requireIdempotencyKey } from '../../middleware/idempotency.js';
import { auditRouter } from '../audit/controller.js';
import { riskRouter } from '../risk/controller.js';
import { disputeAdminRouter } from '../disputes/controller.js';
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
  });

// ---------------------------------------------------------------------------
// Admin MFA bootstrap — registered BEFORE the MFA gate so an admin can
// provision/enable/disable their TOTP. SUPER_ADMIN-only (ROLES_ADMIN grant).
// ---------------------------------------------------------------------------
const mfaBootstrap = express.Router();

mfaBootstrap.get('/status', adminMfaRateLimiter, requirePermission(PERMISSIONS.AUDIT_READ), async (req, res, next) => {
  try {
    const status = await AdminMfaService.getStatus(req.user.id);
    res.json({ userId: req.user.id, ...status });
  } catch (error) {
    next(error);
  }
});

mfaBootstrap.post('/setup', adminMfaRateLimiter, requirePermission(PERMISSIONS.ROLES_ADMIN), async (req, res, next) => {
  try {
    const result = await AdminMfaService.provision(req.user.id);
    await audit(req, 'admin.mfa.setup', {
      targetType: 'user', targetId: req.user.id,
      metadata: { reenrolled: true }
    });
    // Secret + otpauth returned exactly once. Never log them.
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

mfaBootstrap.post('/verify', adminMfaRateLimiter, requirePermission(PERMISSIONS.ROLES_ADMIN), async (req, res, next) => {
  try {
    const { code } = req.body ?? {};
    await AdminMfaService.enable(req.user.id, code);
    await audit(req, 'admin.mfa.enable', {
      targetType: 'user', targetId: req.user.id
    });
    res.json({ enabled: true });
  } catch (error) {
    if (error?.name === 'AdminMfaCodeError') {
      return res.status(403).json({ error: error.message });
    }
    if (error?.name === 'AdminMfaStateError') {
      return res.status(409).json({ error: error.message });
    }
    if (error?.name === 'AdminMfaNotFoundError') {
      return res.status(404).json({ error: error.message });
    }
    next(error);
  }
});

mfaBootstrap.post('/disable', adminMfaRateLimiter, requirePermission(PERMISSIONS.ROLES_ADMIN), async (req, res, next) => {
  try {
    const { code } = req.body ?? {};
    await AdminMfaService.disable(req.user.id, code);
    await audit(req, 'admin.mfa.disable', {
      targetType: 'user', targetId: req.user.id
    });
    res.json({ disabled: true });
  } catch (error) {
    if (error?.name === 'AdminMfaCodeError' || error?.name === 'AdminMfaNotFoundError') {
      return res.status(error.name === 'AdminMfaCodeError' ? 403 : 404).json({ error: error.message });
    }
    next(error);
  }
});

adminRouter.use('/mfa', mfaBootstrap);
adminRouter.use(requireAdminMfa);
// Every admin POST is idempotent: an Idempotency-Key header is required and
// the first response is replayed for retries with the same key (contract §9).
// MFA setup/verify/disable run above this gate so provisioning stays simple.
adminRouter.use(requireIdempotencyKey({ scope: 'admin' }));
adminRouter.use('/audit', auditRouter);
adminRouter.use(disputeAdminRouter);
adminRouter.use(riskRouter);

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
// Contract §9: GET /admin/kyc/cases, POST /admin/kyc/cases/{id}/decision.
// ---------------------------------------------------------------------------

adminRouter.get(
  '/kyc/cases',
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
  '/kyc/cases/:id/decision',
  requirePermission(PERMISSIONS.VERIFICATION_REVIEW),
  async (req, res, next) => {
    try {
      const { decision, note, reason } = req.body ?? {};
      if (!['APPROVE', 'REJECT'].includes(decision)) {
        return res.status(400).json({ error: 'decision must be APPROVE or REJECT' });
      }
      if (decision === 'APPROVE') {
        const { case: verificationCase, replayed } = await approveVerificationCase(req.params.id, {
          adminId: req.user.id,
          note: typeof note === 'string' ? note : null
        });
        await audit(req, 'verification.approve', {
          targetType: 'verification-case',
          targetId: verificationCase.id,
          metadata: { replayed, verifiedById: req.user.id }
        });
        return res.json({ verificationCase, replayed });
      }
      const rejectionReason = typeof reason === 'string' ? reason : 'Rejected by operator';
      const { case: verificationCase, replayed } = await rejectVerificationCase(req.params.id, {
        adminId: req.user.id,
        reason: rejectionReason
      });
      await audit(req, 'verification.reject', {
        targetType: 'verification-case',
        targetId: verificationCase.id,
        metadata: { replayed, reason: rejectionReason }
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
// User directory (SUPPORT / SUPER_ADMIN) — contract §9: GET /admin/users,
// GET /admin/users/{userId}. Operational view; KYC/verification state read-only.
// ---------------------------------------------------------------------------

const USER_OPERATIONAL_FIELDS = {
  id: true,
  email: true,
  phone: true,
  username: true,
  fullName: true,
  displayName: true,
  avatar: true,
  tier: true,
  kycStatus: true,
  emailVerified: true,
  phoneVerified: true,
  ageVerified: true,
  address: true,
  countryCode: true,
  dateOfBirth: true,
  isBanned: true,
  isAdmin: true,
  createdAt: true,
  wallet: { select: { currency: true } }
};

adminRouter.get(
  '/users',
  requirePermission(PERMISSIONS.USERS_MANAGE),
  async (req, res, next) => {
    try {
      const parsed = parsePagination(req.query);
      if (!parsed.ok) return res.status(400).json({ error: 'Invalid pagination params' });
      const { page, limit } = parsed.data;
      const { q, kycStatus, isBanned } = req.query;
      const where = {
        ...(typeof q === 'string' && q.trim()
          ? {
              OR: [
                { email: { contains: q.trim(), mode: 'insensitive' } },
                { phone: { contains: q.trim() } },
                { username: { contains: q.trim(), mode: 'insensitive' } },
                { fullName: { contains: q.trim(), mode: 'insensitive' } }
              ]
            }
          : {}),
        ...(typeof kycStatus === 'string' && KYC_STATUSES.includes(kycStatus) ? { kycStatus } : {}),
        ...(isBanned === 'true' ? { isBanned: true } : isBanned === 'false' ? { isBanned: false } : {})
      };
      const skip = (page - 1) * limit;
      const [users, total] = await Promise.all([
        prisma.user.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit, select: USER_OPERATIONAL_FIELDS }),
        prisma.user.count({ where })
      ]);
      res.json({ users, total, page, totalPages: Math.ceil(total / limit) });
    } catch (error) {
      next(error);
    }
  }
);

adminRouter.get(
  '/users/:userId',
  requirePermission(PERMISSIONS.USERS_MANAGE),
  async (req, res, next) => {
    try {
      const target = await prisma.user.findUnique({
        where: { id: req.params.userId },
        select: {
          ...USER_OPERATIONAL_FIELDS,
          verificationCases: { orderBy: { createdAt: 'desc' }, take: 1 },
          adminRoleAssignments: { include: { role: true }, orderBy: { assignedAt: 'asc' } }
        }
      });
      if (!target) return res.status(404).json({ error: 'User not found' });
      const roles = target.adminRoleAssignments.map((a) => a.role.name);
      res.json({
        ...target,
        adminRoleAssignments: undefined,
        roles,
        verificationStatus: target.verificationCases?.[0]?.status ?? target.kycStatus ?? 'NONE'
      });
    } catch (error) {
      next(error);
    }
  }
);

// ---------------------------------------------------------------------------
// Match evidence (GAME_OPERATIONS / SUPER_ADMIN) — contract §9:
// GET /admin/matches/{matchId}/evidence. Read-only replay/evidence view.
// ---------------------------------------------------------------------------

const MATCH_EVIDENCE_EVENT_CAP = 1000;

adminRouter.get(
  '/matches/:matchId/evidence',
  requirePermission(PERMISSIONS.MATCH_EVIDENCE_READ),
  async (req, res, next) => {
    try {
      const match = await prisma.match.findUnique({
        where: { id: req.params.matchId },
        include: {
          participants: {
            include: { user: { select: { id: true, email: true, username: true, displayName: true, avatar: true, tier: true, kycStatus: true, isBanned: true } } }
          },
          stakeReservations: { orderBy: { createdAt: 'asc' } },
          settlements: { orderBy: { createdAt: 'asc' } },
          receipts: { orderBy: { createdAt: 'asc' } },
          gameEvents: { orderBy: { createdAt: 'asc' }, take: MATCH_EVIDENCE_EVENT_CAP },
          connectionEvents: { orderBy: { createdAt: 'asc' }, take: MATCH_EVIDENCE_EVENT_CAP },
          gameState: true,
          snapshots: { orderBy: { createdAt: 'asc' }, take: MATCH_EVIDENCE_EVENT_CAP }
        }
      });
      if (!match) return res.status(404).json({ error: 'Match not found' });

      const moves = await prisma.matchMove.findMany({
        where: { matchId: req.params.matchId },
        orderBy: { moveNumber: 'asc' },
        take: MATCH_EVIDENCE_EVENT_CAP,
        select: { moveNumber: true, playerId: true, fromSquare: true, toSquare: true, capturedSquares: true, isKingMove: true, path: true, clientMoveId: true, stateVersion: true, createdAt: true }
      });

      const disputes = await prisma.disputeCase.findMany({
        where: { matchId: req.params.matchId },
        orderBy: { createdAt: 'asc' },
        include: { evidence: { orderBy: { uploadedAt: 'asc' } } }
      });

      const corrections = await prisma.matchResultCorrection.findMany({
        where: { matchId: req.params.matchId },
        orderBy: { createdAt: 'asc' }
      });

      res.json({
        match,
        moves,
        disputes,
        resultCorrections: corrections,
        evidenceCaps: { moves: moves.length, gameEvents: match.gameEvents.length, connectionEvents: match.connectionEvents.length, snapshots: match.snapshots.length }
      });
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