import prisma from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { recordAdminAction } from '../audit/service.js';
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
 * Admin MFA hook (placeholder). When ADMIN_MFA_ENFORCED=true every admin
 * request needs `x-admin-mfa-code` = ADMIN_MFA_CODE or it is denied+audited.
 * Off by default; a real TOTP provider slots in here later.
 */
export const requireAdminMfa = (req, res, next) => {
  const enforced = process.env.ADMIN_MFA_ENFORCED === 'true';
  if (!enforced) return next();

  const code = req.get('x-admin-mfa-code');
  const pass = typeof code === 'string' && code === process.env.ADMIN_MFA_CODE;
  recordAdminAction({
    adminId: req.user?.id ?? 'unknown',
    action: 'admin.mfa',
    outcome: pass ? 'SUCCESS' : 'DENIED',
    targetType: 'admin',
    targetId: req.user?.id ?? null,
    metadata: { route: `${req.method} ${req.originalUrl || req.path}` },
    ip: req.ip,
    userAgent: req.get('user-agent'),
    requestId: req.id
  }).catch((err) => logger.warn({ err }, 'Failed to write MFA audit row'));

  if (!pass) {
    return res.status(403).json({ error: 'Admin MFA code required' });
  }
  next();
};