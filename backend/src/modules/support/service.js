import prisma from '../../utils/db.js';
import logger from '../../utils/logger.js';

/**
 * Minimal MVP support intake (§W8) on the already-shipped schema:
 *   - Players raise a SupportCase (typed, optional match link) that opens an
 *     append-only SupportCaseEvent trail. They attach follow-up messages to an
 *     open case and can close it themselves.
 *   - Support-team (admin, SUPPORT+ via `disputes.manage`) lists/assigns/notes
 *     and transitions status without ever touching money — money movement stays
 *     in FINANCE/RISK/ledger surfaces. Every admin action is audited by the
 *     admin controller.
 *
 * No PII beyond what the user chooses to type is ever projected back, and the
 * events table is append-only (no edits, no deletes).
 */

export const SUPPORT_CASE_TYPES = Object.freeze([
  'GENERAL',
  'PAYMENT',
  'WITHDRAWAL',
  'KYC',
  'MATCH',
  'ACCOUNT',
  'SAFER_PLAY'
]);

export const SUPPORT_CASE_STATUSES = Object.freeze([
  'OPEN',
  'IN_PROGRESS',
  'WAITING_USER',
  'RESOLVED',
  'CLOSED'
]);

const PLAYER_OPEN_STATUSES = Object.freeze(['OPEN', 'IN_PROGRESS', 'WAITING_USER']);

export class SupportCaseError extends Error {
  constructor(message = 'Support case could not be processed') {
    super(message);
    this.name = 'SupportCaseError';
  }
}

export class SupportCaseNotFoundError extends Error {
  constructor(message = 'Support case not found') {
    super(message);
    this.name = 'SupportCaseNotFoundError';
  }
}

export class SupportCaseOpenLimitError extends Error {
  constructor(message = 'Open support-case limit reached') {
    super(message);
    this.name = 'SupportCaseOpenLimitError';
  }
}

export class SupportCaseClosedError extends Error {
  constructor(message = 'Support case is closed') {
    super(message);
    this.name = 'SupportCaseClosedError';
  }
}

const toView = (row) => ({
  id: row.id,
  type: row.type,
  status: row.status,
  subject: row.subject,
  description: row.description ?? null,
  relatedMatchId: row.relatedMatchId ?? null,
  assignedAdminUserId: row.assignedAdminUserId ?? null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  closedAt: row.closedAt ?? null,
  ...(row.events ? { events: row.events.map(toEventView) } : {}),
  ...(row._commentCount !== undefined ? { commentCount: row._commentCount } : {})
});

const toEventView = (row) => ({
  id: row.id,
  eventType: row.eventType,
  message: row.message ?? null,
  metadata: row.metadata ?? null,
  createdAt: row.createdAt
});

const PLAYER_MESSAGE_TYPES = Object.freeze([
  'CASE_OPENED',
  'USER_MESSAGE',
  'USER_CLOSED'
]);

/**
 * Opens a support case. Only `type` and `subject` are required; a malformed
 * subject is rejected. A player may keep a bounded number of open cases so the
 * queue cannot be flooded.
 */
export const openSupportCase = async (
  userId,
  { type, subject, description = null, relatedMatchId = null },
  { dbp = prisma } = {}
) => {
  if (!type || !SUPPORT_CASE_TYPES.includes(type)) {
    throw new SupportCaseError('Unsupported support case type');
  }
  if (typeof subject !== 'string' || !subject.trim() || subject.trim().length > 200) {
    throw new SupportCaseError('Subject is required (max 200 chars)');
  }

  const openCount = await dbp.supportCase.count({
    where: {
      userId,
      status: { in: PLAYER_OPEN_STATUSES }
    }
  });
  if (openCount >= MAX_OPEN_CASES_PER_PLAYER) {
    throw new SupportCaseOpenLimitError();
  }

  return dbp.$transaction(async (tx) => {
    const created = await tx.supportCase.create({
      data: {
        userId,
        type,
        subject: subject.trim().slice(0, 200),
        ...(typeof description === 'string' && description.trim() !== ''
          ? { description: description.trim().slice(0, 4000) }
          : {}),
        ...(typeof relatedMatchId === 'string' && relatedMatchId
          ? { relatedMatchId }
          : {})
      }
    });
    await tx.supportCaseEvent.create({
      data: {
        supportCaseId: created.id,
        actorUserId: userId,
        eventType: 'CASE_OPENED',
        message: 'Case opened'
      }
    });
    logger.info({ userId, caseId: created.id, type }, 'Support case opened');
    return toView(created);
  });
};

export const listMySupportCases = async (userId, { dbp = prisma } = {}) => {
  const rows = await dbp.supportCase.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 100
  });
  return rows.map(toView);
};

export const getMySupportCase = async (userId, caseId, { dbp = prisma } = {}) => {
  const row = await dbp.supportCase.findUnique({
    where: { id: caseId },
    include: { events: { orderBy: { createdAt: 'asc' } } }
  });
  if (!row || row.userId !== userId) throw new SupportCaseNotFoundError();
  return toView(row);
};

/**
 * Appends a user message to a case the player owns and that is still open.
 * Re-opening a WAITING_USER case on a new message is implicit (no status
 * rewrite in this minimal surface — the queue simply reflects new activity).
 */
export const addUserMessageToSupportCase = async (
  userId,
  caseId,
  { message },
  { dbp = prisma } = {}
) => {
  if (typeof message !== 'string' || !message.trim() || message.trim().length > 2000) {
    throw new SupportCaseError('Message is required (max 2000 chars)');
  }
  const row = await dbp.supportCase.findUnique({ where: { id: caseId } });
  if (!row || row.userId !== userId) throw new SupportCaseNotFoundError();
  if (!PLAYER_OPEN_STATUSES.includes(row.status)) throw new SupportCaseClosedError();

  const event = await dbp.supportCaseEvent.create({
    data: {
      supportCaseId: caseId,
      actorUserId: userId,
      eventType: 'USER_MESSAGE',
      message: message.trim().slice(0, 2000)
    }
  });
  return toEventView(event);
};

/**
 * Player-side close. The case is closed (not resolved — resolution is a team
 * judgement) if the player owns it and it is still open.
 */
export const closeMySupportCase = async (userId, caseId, { dbp = prisma } = {}) => {
  const row = await dbp.supportCase.findUnique({ where: { id: caseId } });
  if (!row || row.userId !== userId) throw new SupportCaseNotFoundError();
  if (!PLAYER_OPEN_STATUSES.includes(row.status)) throw new SupportCaseClosedError();

  return dbp.$transaction(async (tx) => {
    const updated = await tx.supportCase.update({
      where: { id: caseId },
      data: { status: 'CLOSED', closedAt: new Date() }
    });
    await tx.supportCaseEvent.create({
      data: {
        supportCaseId: caseId,
        actorUserId: userId,
        eventType: 'USER_CLOSED',
        message: 'Case closed by player'
      }
    });
    return toView(updated);
  });
};

const MAX_OPEN_CASES_PER_PLAYER = 4;

// ---------------------------------------------------------------------------
// Support-team (admin) surface — all calls are prepared for the admin
// controller, which applies requirePermission + idempotency + audit.
// ---------------------------------------------------------------------------

export const listSupportCases = async (
  { status = null, type = null, page = 1, limit = 20 },
  { dbp = prisma } = {}
) => {
  const where = {};
  if (SUPPORT_CASE_STATUSES.includes(status)) where.status = status;
  if (SUPPORT_CASE_TYPES.includes(type)) where.type = type;
  const skip = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    dbp.supportCase.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip,
      take: limit
    }),
    dbp.supportCase.count({ where })
  ]);
  return { cases: rows.map(toView), total, page, totalPages: Math.ceil(total / limit) };
};

export const getSupportCase = async (caseId, { dbp = prisma } = {}) => {
  const row = await dbp.supportCase.findUnique({
    where: { id: caseId },
    include: { events: { orderBy: { createdAt: 'asc' } } }
  });
  if (!row) throw new SupportCaseNotFoundError();
  return toView(row);
};

/**
 * Assigns the case to an admin (assignedAdminUserId) without changing status.
 * Pass assignedAdminUserId: null to unassign.
 */
export const assignSupportCase = async (
  caseId,
  assignedAdminUserId,
  { dbp = prisma } = {}
) => {
  const row = await dbp.supportCase.findUnique({ where: { id: caseId } });
  if (!row) throw new SupportCaseNotFoundError();
  const now = new Date();
  const updated = await dbp.supportCase.update({
    where: { id: caseId },
    data: { assignedAdminUserId, updatedAt: now }
  });
  if (updated.assignedAdminUserId !== row.assignedAdminUserId) {
    await dbp.supportCaseEvent.create({
      data: {
        supportCaseId: caseId,
        actorUserId: null,
        eventType: 'ADMIN_ASSIGNED',
        message: assignedAdminUserId
          ? 'Case assigned'
          : 'Case unassigned'
      }
    });
  }
  return toView(updated);
};

/**
 * Team status transition. A closed case cannot be reopened (append-only).
 * RESOLVED here means the support issue was settled — it carries no money
 * consequence by itself (that always lives in the ledger).
 */
export const transitionSupportCase = async (
  caseId,
  { status, note = null },
  { dbp = prisma } = {}
) => {
  if (!status || !SUPPORT_CASE_STATUSES.includes(status)) {
    throw new SupportCaseError('Unsupported support case status');
  }
  const row = await dbp.supportCase.findUnique({ where: { id: caseId } });
  if (!row) throw new SupportCaseNotFoundError();
  if (row.status === 'CLOSED') throw new SupportCaseClosedError();

  const now = new Date();
  const updated = await dbp.supportCase.update({
    where: { id: caseId },
    data: {
      status,
      ...(status === 'CLOSED' || status === 'RESOLVED' ? { closedAt: now } : { closedAt: null }),
      updatedAt: now
    }
  });
  await dbp.supportCaseEvent.create({
    data: {
      supportCaseId: caseId,
      eventType: 'STATUS_CHANGED',
      message: note?.trim()?.slice(0, 2000) ?? `Status changed to ${status}`
    }
  });
  return toView(updated);
};

export default {
  openSupportCase,
  listMySupportCases,
  getMySupportCase,
  addUserMessageToSupportCase,
  closeMySupportCase,
  listSupportCases,
  getSupportCase,
  assignSupportCase,
  transitionSupportCase,
  PlayerMessageTypes: PLAYER_MESSAGE_TYPES,
  SupportCaseError,
  SupportCaseNotFoundError,
  SupportCaseOpenLimitError,
  SupportCaseClosedError
};
