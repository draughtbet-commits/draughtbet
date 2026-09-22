import prisma from '../../utils/db.js';
import { parsePagination } from '../../utils/pagination.js';

// Durable admin audit trail. Every privileged mutation (+ denied permission
// checks) is written with the acting admin and request metadata so the
// READ_ONLY_AUDITOR role can answer who did what to whom.

export const recordAdminAction = async ({
  adminId,
  action,
  outcome = 'SUCCESS',
  targetType = null,
  targetId = null,
  metadata = null,
  ip = null,
  userAgent = null,
  requestId = null,
  dbp = prisma
}) => {
  return dbp.adminAuditLog.create({
    data: {
      adminId,
      action,
      outcome,
      targetType,
      targetId,
      metadata,
      ip,
      userAgent,
      requestId
    }
  });
};

export const AUDIT_OUTCOMES = Object.freeze(['SUCCESS', 'FAILURE', 'DENIED']);

// Convenience wrapper for controller handlers: pulls admin identity + request
// metadata straight off the request so modules don't each re-implement it.
export const auditFromRequest = (
  req,
  action,
  { targetType = null, targetId = null, metadata = null, outcome = 'SUCCESS', dbp = prisma } = {}
) =>
  recordAdminAction({
    adminId: req.user.id,
    action,
    outcome,
    targetType,
    targetId,
    metadata,
    ip: req.ip,
    userAgent: req.get('user-agent'),
    requestId: req.id,
    dbp
  });

export const listAdminActions = async ({
  page = 1,
  limit = 20,
  adminId = null,
  action = null,
  outcome = null,
  targetId = null,
  dbp = prisma
} = {}) => {
  const where = {
    ...(adminId ? { adminId } : {}),
    ...(action ? { action } : {}),
    ...(outcome && AUDIT_OUTCOMES.includes(outcome) ? { outcome } : {}),
    ...(targetId ? { targetId } : {})
  };
  const skip = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    dbp.adminAuditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit
    }),
    dbp.adminAuditLog.count({ where })
  ]);
  return {
    logs: rows,
    total,
    page,
    totalPages: Math.ceil(total / limit)
  };
};

export const auditPagination = (query) => {
  const parsed = parsePagination(query);
  if (!parsed.ok) return null;
  const { page, limit } = parsed.data;
  const { adminId, action, outcome, targetId } = query;
  return {
    page,
    limit,
    ...(typeof adminId === 'string' && adminId ? { adminId } : {}),
    ...(typeof action === 'string' && action ? { action } : {}),
    ...(typeof outcome === 'string' && AUDIT_OUTCOMES.includes(outcome) ? { outcome } : {}),
    ...(typeof targetId === 'string' && targetId ? { targetId } : {})
  };
};