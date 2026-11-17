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

export const listAdminActions = async ({
  page = 1,
  limit = 20,
  adminId = null,
  action = null,
  outcome = null,
  targetId = null,
  targetType = null,
  dateFrom = null,
  dateTo = null,
  search = null,
  sortBy = 'createdAt',
  order = 'desc',
  dbp = prisma
} = {}) => {
  const where = {
    ...(adminId ? { adminId } : {}),
    ...(action ? { action } : {}),
    ...(outcome && AUDIT_OUTCOMES.includes(outcome) ? { outcome } : {}),
    ...(targetId ? { targetId } : {}),
    ...(targetType ? { targetType } : {})
  };

  if (dateFrom || dateTo) {
    const createdAt = {};
    if (dateFrom) {
      const d = new Date(dateFrom);
      if (!Number.isNaN(d.getTime())) createdAt.gte = d;
    }
    if (dateTo) {
      const d = new Date(dateTo);
      if (!Number.isNaN(d.getTime())) createdAt.lte = d;
    }
    if (Object.keys(createdAt).length > 0) {
      where.createdAt = createdAt;
    }
  }

  if (search && typeof search === 'string' && search.trim() !== '') {
    const term = search.trim();
    where.OR = [
      { action: { contains: term, mode: 'insensitive' } },
      { adminId: { contains: term, mode: 'insensitive' } },
      { targetId: { contains: term, mode: 'insensitive' } },
      { targetType: { contains: term, mode: 'insensitive' } },
      { requestId: { contains: term, mode: 'insensitive' } }
    ];
  }

  const validSort = ['createdAt', 'action', 'outcome'];
  const sortField = validSort.includes(sortBy) ? sortBy : 'createdAt';
  const sortOrder = order === 'asc' ? 'asc' : 'desc';

  const skip = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    dbp.adminAuditLog.findMany({
      where,
      orderBy: { [sortField]: sortOrder },
      skip,
      take: limit
    }),
    dbp.adminAuditLog.count({ where })
  ]);

  let logs = rows;
  if (typeof dbp.user?.findMany === 'function' && rows.length > 0) {
    const adminIds = [...new Set(rows.map((r) => r.adminId).filter(Boolean))];
    if (adminIds.length > 0) {
      try {
        const actors = await dbp.user.findMany({
          where: { id: { in: adminIds } },
          select: {
            id: true,
            email: true,
            username: true,
            adminRoleAssignments: {
              select: { role: { select: { name: true } } }
            }
          }
        });
        const actorMap = new Map(
          (actors ?? []).map((u) => [
            u.id,
            {
              email: u.email,
              username: u.username ?? null,
              roles: (u.adminRoleAssignments ?? []).map((a) => a.role?.name).filter(Boolean)
            }
          ])
        );
        logs = rows.map((r) => ({
          ...r,
          actor: actorMap.get(r.adminId) ?? null
        }));
      } catch {
        logs = rows;
      }
    }
  }

  return {
    logs,
    total,
    page,
    totalPages: Math.ceil(total / limit)
  };
};

export const getAdminActionDetail = async (id, { dbp = prisma } = {}) => {
  const row = await dbp.adminAuditLog.findUnique({ where: { id } });
  if (!row) return null;
  let actor = null;
  if (row.adminId && typeof dbp.user?.findUnique === 'function') {
    try {
      const u = await dbp.user.findUnique({
        where: { id: row.adminId },
        select: {
          id: true,
          email: true,
          username: true,
          fullName: true,
          adminRoleAssignments: {
            select: { role: { select: { name: true } } }
          }
        }
      });
      if (u) {
        actor = {
          id: u.id,
          email: u.email,
          username: u.username ?? null,
          fullName: u.fullName ?? null,
          roles: (u.adminRoleAssignments ?? []).map((a) => a.role?.name).filter(Boolean)
        };
      }
    } catch {
      actor = null;
    }
  }
  return { ...row, actor };
};

export const auditPagination = (query) => {
  const parsed = parsePagination(query);
  if (!parsed.ok) return null;
  const { page, limit } = parsed.data;
  const { adminId, action, outcome, targetId, targetType, dateFrom, dateTo, search, sortBy, order } = query;
  return {
    page,
    limit,
    ...(typeof adminId === 'string' && adminId ? { adminId } : {}),
    ...(typeof action === 'string' && action ? { action } : {}),
    ...(typeof outcome === 'string' && AUDIT_OUTCOMES.includes(outcome) ? { outcome } : {}),
    ...(typeof targetId === 'string' && targetId ? { targetId } : {}),
    ...(typeof targetType === 'string' && targetType ? { targetType } : {}),
    ...(typeof dateFrom === 'string' && dateFrom ? { dateFrom } : {}),
    ...(typeof dateTo === 'string' && dateTo ? { dateTo } : {}),
    ...(typeof search === 'string' && search ? { search } : {}),
    ...(typeof sortBy === 'string' && sortBy ? { sortBy } : {}),
    ...(typeof order === 'string' && order ? { order } : {})
  };
};