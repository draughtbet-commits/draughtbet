import prisma from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { recordAdminAction } from '../audit/service.js';
import { AdminMfaService } from '../mfa/service.js';
import {
  ADMIN_ROLES,
  ROLE_DESCRIPTIONS,
  roleHasPermission
} from './permissions.js';

export class PermissionDeniedError extends Error {
  constructor(message = 'Insufficient admin permission') {
    super(message);
    this.name = 'PermissionDeniedError';
  }
}

export class RoleAssignmentError extends Error {
  constructor(message = 'Invalid role assignment') {
    super(message);
    this.name = 'RoleAssignmentError';
  }
}

/**
 * Idempotent seed of the six known roles. Safe to call on every boot and in
 * tests; running it must never fail on a fresh or existing database.
 */
export const ensureRoles = async ({ dbp = prisma } = {}) => {
  await Promise.all(
    ADMIN_ROLES.map((name) =>
      dbp.adminRole.upsert({
        where: { name },
        create: { name, description: ROLE_DESCRIPTIONS[name] },
        update: { description: ROLE_DESCRIPTIONS[name] }
      })
    )
  );
  return ADMIN_ROLES;
};

export const getUserRoles = async (userId, { dbp = prisma } = {}) => {
  return dbp.adminRoleAssignment.findMany({
    where: { userId },
    include: { role: true },
    orderBy: { assignedAt: 'asc' }
  });
};

export const getRoleNames = async (userId, { dbp = prisma } = {}) => {
  const assignments = await getUserRoles(userId, { dbp });
  return assignments.map((a) => a.role.name);
};

/**
 * Single source of truth for "may this user perform this permission?".
 * Resolved fresh from the database on every check; nothing is cached in a JWT.
 */
export const hasPermission = async (userId, permission, { dbp = prisma } = {}) => {
  const assignments = await dbp.adminRoleAssignment.findMany({
    where: { userId },
    include: { role: true }
  });
  return assignments.some((a) => roleHasPermission(a.role.name, permission));
};

export const assignRole = async (
  userId,
  roleName,
  { assignedBy = null, dbp = prisma } = {}
) => {
  if (!ADMIN_ROLES.includes(roleName)) {
    throw new RoleAssignmentError(`Unknown admin role: ${roleName}`);
  }
  await ensureRoles({ dbp });
  const role = await dbp.adminRole.findUniqueOrThrow({ where: { name: roleName } });
  return dbp.adminRoleAssignment.upsert({
    where: { userId_roleId: { userId, roleId: role.id } },
    create: { userId, roleId: role.id, assignedBy },
    update: { assignedBy, assignedAt: new Date() }
  });
};

export const revokeRole = async (
  userId,
  roleName,
  { assignedBy = null, dbp = prisma } = {}
) => {
  const role = await dbp.adminRole.findUnique({ where: { name: roleName } });
  if (!role) return null;

  if (roleName === 'SUPER_ADMIN') {
    const existingSuperAdmins = await dbp.adminRoleAssignment.count({
      where: { role: { name: 'SUPER_ADMIN' } }
    });
    const targetHasRole = await dbp.adminRoleAssignment.findUnique({
      where: { userId_roleId: { userId, roleId: role.id } }
    });
    if (targetHasRole && existingSuperAdmins <= 1) {
      throw new RoleAssignmentError('Cannot revoke the last remaining SUPER_ADMIN');
    }
  }

  return dbp.adminRoleAssignment.deleteMany({
    where: { userId, roleId: role.id }
  });
};

/**
 * Route guard. Runs after requireAuth (req.user set). Loads the caller's roles
 * from the DB and on denial writes a DENIED audit row before 403ing — denied
 * attempts are as visible as successes.
 */
export const requirePermission = (permission) => async (req, res, next) => {
  try {
    const assignments = await prisma.adminRoleAssignment.findMany({
      where: { userId: req.user.id },
      include: { role: true }
    });
    const allowed = assignments.some((a) => roleHasPermission(a.role.name, permission));
    if (!allowed) {
      await recordAdminAction({
        adminId: req.user.id,
        action: `permission.denied:${permission}`,
        outcome: 'DENIED',
        targetType: 'admin',
        targetId: req.user.id,
        metadata: { route: `${req.method} ${req.originalUrl || req.path}` },
        ip: req.ip,
        userAgent: req.get('user-agent'),
        requestId: req.id
      });
      return res.status(403).json({ error: 'Insufficient admin permission' });
    }
    req.adminRoles = assignments.map((a) => a.role.name);
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Route guard for administrative endpoints accessible to any of the 6 roles.
 * Runs after requireAuth (req.user set). Verifies the caller holds at least
 * one AdminRoleAssignment in the database and populates req.adminRoles.
 */
export const requireAnyAdminRole = async (req, res, next) => {
  try {
    const assignments = await getUserRoles(req.user.id);
    if (!assignments || assignments.length === 0) {
      await recordAdminAction({
        adminId: req.user.id,
        action: 'admin.unauthorized',
        outcome: 'DENIED',
        targetType: 'admin',
        targetId: req.user.id,
        metadata: { route: `${req.method} ${req.originalUrl || req.path}` },
        ip: req.ip,
        userAgent: req.get('user-agent'),
        requestId: req.id
      });
      return res.status(403).json({ error: 'Account does not have admin privileges' });
    }
    req.adminRoles = assignments.map((a) => a.role.name);
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Admin MFA gate — RFC-6238 TOTP (per-admin secret, AES-256-GCM encrypted at rest)
 * with single-use recovery codes and session-bound MFA verification.
 *
 * Enforced whenever ADMIN_MFA_ENFORCED=true, or by default in production unless
 * explicitly set to "false". Cannot be bypassed via login, refresh, or recovery:
 * - Unprovisioned or un-enabled admins are denied with MFA_ENROLLMENT_REQUIRED.
 * - Locked admins (5 consecutive wrong codes) are denied even with a valid code.
 * - Callers must either hold an MFA-verified session whose `mfaVerifiedAt` is
 *   >= `AdminMfa.enabledAt`, OR supply a valid current `x-admin-mfa-code` header.
 */
export const requireAdminMfa = async (req, res, next) => {
  if (!AdminMfaService.isEnforced()) return next();

  const userId = req.user?.id;
  if (!userId) return next();

  const auditMfa = (outcome, metadata = {}) =>
    recordAdminAction({
      adminId: userId,
      action: 'admin.mfa',
      outcome,
      targetType: 'admin',
      targetId: userId,
      metadata: { route: `${req.method} ${req.originalUrl || req.path}`, ...metadata },
      ip: req.ip,
      userAgent: req.get('user-agent'),
      requestId: req.id
    }).catch((err) => logger.warn({ err }, 'Failed to write MFA audit row'));

  try {
    const status = await AdminMfaService.getDetailedStatus(userId);
    if (!status.provisioned) {
      await auditMfa('DENIED', { reason: 'not_provisioned' });
      return res.status(403).json({
        error: 'Admin MFA must be provisioned before admin access.',
        code: 'MFA_ENROLLMENT_REQUIRED'
      });
    }
    if (!status.enabled) {
      await auditMfa('DENIED', { reason: 'not_enabled' });
      return res.status(403).json({
        error: 'Admin MFA is provisioned but not enabled yet.',
        code: 'MFA_ENROLLMENT_REQUIRED'
      });
    }
    if (await AdminMfaService.isLocked(userId)) {
      await auditMfa('DENIED', { reason: 'locked' });
      return res.status(403).json({
        error: 'Too many failed admin MFA attempts. Try again later.',
        code: 'MFA_LOCKED'
      });
    }

    // Path A: Session was already verified via TOTP or recovery code AFTER the
    // current MFA secret was enabled (so re-enrollment invalidates older sessions).
    const enabledAtMs = status.enabledAt ? status.enabledAt.getTime() : 0;
    const sessionMfaValid =
      req.auth?.mfaVerified === true &&
      typeof req.auth?.mfaVerifiedAt === 'number' &&
      req.auth.mfaVerifiedAt >= enabledAtMs;
    if (sessionMfaValid) {
      return next();
    }

    // Path B: Per-request `x-admin-mfa-code` header (CLI / automation / step-up).
    const headerCode = req.get('x-admin-mfa-code');
    if (headerCode) {
      const ok = await AdminMfaService.verify(userId, headerCode, {
        allowReplayWithinStep: true
      });
      if (!ok) {
        await AdminMfaService.recordFailure(userId);
        await auditMfa('DENIED', { reason: 'bad_code' });
        return res.status(403).json({
          error: 'Invalid admin MFA code.',
          code: 'MFA_INVALID_CODE'
        });
      }
      await auditMfa('SUCCESS', { via: 'header' });
      return next();
    }

    await auditMfa('DENIED', { reason: 'mfa_required' });
    return res.status(403).json({
      error: 'Admin MFA verification is required.',
      code: 'MFA_REQUIRED'
    });
  } catch (err) {
    next(err);
  }
};
