import prisma from '../../utils/db.js';
import { AdminService } from '../admin/service.js';

// Dispute lifecycle. Two entry points share this service:
//   1. Participant raise: POST /matches/:matchId/disputes (window + eligibility
//      + duplicate guard, creates an OPEN case with optional evidence refs).
//   2. Admin decide: POST /admin/disputes/:id/decision — an append-only result
//      correction row when the adjudicated outcome differs from what was
//      settled, plus (separately, in its own balanced transaction) an optional
//      ledger adjustment when money must change. History is never rewritten.
//
// The money correction is intentionally a SEPARATE transaction (blueprint
// §22.2 / decisions §34-35): it is idempotent per reference `dispute:{caseId}`,
// so a failed adjustment can be retried through POST /admin/ledger/adjustments
// with that same reference without double-moving funds.

export const DISPUTE_STATUS_LIST = ['OPEN', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED'];
export const DISPUTE_EVIDENCE_TYPES = ['SCREENSHOT', 'CHAT_LOG', 'GAME_LOG', 'SYSTEM_LOG', 'OTHER'];
export const DISPUTE_ELIGIBLE_MATCH_STATUSES = ['COMPLETED', 'FORFEITED', 'SETTLED', 'RELEASED'];
export const DISPUTE_WINDOW_HOURS = Number(process.env.DISPUTE_WINDOW_HOURS ?? 72);

export class DisputeCaseNotFoundError extends Error {
  constructor(message = 'Dispute case not found') {
    super(message);
    this.name = 'DisputeCaseNotFoundError';
  }
}

export class DisputeCaseNotReviewableError extends Error {
  constructor(message = 'Dispute is already decided') {
    super(message);
    this.name = 'DisputeCaseNotReviewableError';
  }
}

export class DisputeNotEligibleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DisputeNotEligibleError';
  }
}

export class DisputeWindowExpiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DisputeWindowExpiredError';
  }
}

export class DuplicateDisputeError extends Error {
  constructor(message = 'A dispute for this match is already open') {
    super(message);
    this.name = 'DuplicateDisputeError';
  }
}

export class DisputeAdjustmentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DisputeAdjustmentError';
  }
}

const isParticipant = async (matchId, userId) => {
  const direct = await prisma.matchParticipant.findUnique({
    where: { matchId_userId: { matchId, userId } },
    select: { id: true }
  });
  if (direct) return true;
  return null;
};

export const listDisputes = async ({ page, limit, status = null }) => {
  const where = typeof status === 'string' && DISPUTE_STATUS_LIST.includes(status) ? { status } : {};
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
    ? await prisma.user.findMany({ where: { id: { in: raisedBy } }, select: { id: true, email: true } })
    : [];
  const emailByUser = Object.fromEntries(raisers.map((u) => [u.id, u.email]));
  const disputes = rows.map((r) => ({ ...r, raisedByEmail: emailByUser[r.raisedBy] ?? null }));
  return { disputes, total, page, totalPages: Math.ceil(total / limit) };
};

export const addDisputeEvidence = async (caseId, { type, url, description = null }) => {
  const existing = await prisma.disputeCase.findUnique({ where: { id: caseId } });
  if (!existing) throw new DisputeCaseNotFoundError();
  return prisma.disputeEvidence.create({
    data: {
      caseId,
      type,
      url,
      ...(typeof description === 'string' ? { description } : {})
    }
  });
};

export const raiseDispute = async (matchId, userId, { category = null, message, evidence = [] }) => {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: { id: true, status: true, endedAt: true, createdAt: true, playerLightId: true, playerDarkId: true }
  });
  if (!match) throw new DisputeNotEligibleError('Match not found');

  if (
    match.playerLightId !== userId &&
    match.playerDarkId !== userId &&
    !(await isParticipant(matchId, userId))
  ) {
    throw new DisputeNotEligibleError('Only match participants can raise a dispute');
  }
  if (!DISPUTE_ELIGIBLE_MATCH_STATUSES.includes(match.status)) {
    throw new DisputeNotEligibleError('This match cannot be disputed in its current state');
  }

  const windowRef = match.endedAt ?? match.createdAt;
  const deadline =
    new Date(windowRef).getTime() + DISPUTE_WINDOW_HOURS * 60 * 60 * 1000;
  if (Date.now() > deadline) {
    throw new DisputeWindowExpiredError('The dispute window for this match has expired');
  }

  const dup = await prisma.disputeCase.findFirst({
    where: { matchId, raisedBy: userId, status: { in: ['OPEN', 'UNDER_REVIEW'] } },
    select: { id: true }
  });
  if (dup) throw new DuplicateDisputeError();

  return prisma.$transaction(async (tx) => {
    const created = await tx.disputeCase.create({
      data: {
        matchId,
        raisedBy: userId,
        ...(typeof category === 'string' ? { category } : {}),
        reason: message
      }
    });
    if (Array.isArray(evidence)) {
      for (const item of evidence) {
        if (item && DISPUTE_EVIDENCE_TYPES.includes(item.type) && typeof item.url === 'string' && item.url.trim() !== '') {
          await tx.disputeEvidence.create({
            data: {
              caseId: created.id,
              type: item.type,
              url: item.url.trim(),
              ...(typeof item.description === 'string' ? { description: item.description } : {})
            }
          });
        }
      }
    }
    return created;
  });
};

export const decideDispute = async (caseId, callerId, { status, resolution, resultCorrection = null, moneyAdjustment = null }) => {
  const existing = await prisma.disputeCase.findUnique({
    where: { id: caseId },
    include: { match: { select: { winnerId: true, endReason: true } } }
  });
  if (!existing) throw new DisputeCaseNotFoundError();
  if (!['OPEN', 'UNDER_REVIEW'].includes(existing.status)) {
    throw new DisputeCaseNotReviewableError();
  }

  const resolutionText = resolution.trim();

  // 1. Decision + append-only correction row — one transaction.
  const decidedResult = await prisma.$transaction(async (tx) => {
    const updated = await tx.disputeCase.update({
      where: { id: caseId },
      data: {
        status,
        resolution: resolutionText,
        decidedBy: callerId,
        decidedAt: new Date()
      }
    });
    let correction = null;
    if (resultCorrection) {
      correction = await tx.matchResultCorrection.create({
        data: {
          matchId: existing.matchId,
          disputeCaseId: caseId,
          priorWinnerId: existing.match?.winnerId ?? null,
          correctedWinnerId: resultCorrection.winnerId ?? null,
          priorEndReason: existing.match?.endReason ?? null,
          correctedEndReason: resultCorrection.endReason ?? null,
          reason: resolutionText,
          decidedBy: callerId
        }
      });
    }
    return { updated, correction };
  });

  // 2. Optional money correction — SEPARATE balanced transaction, idempotent
  //    per reference so a failed run is safely retriable.
  let adjustment = null;
  if (moneyAdjustment) {
    try {
      adjustment = await AdminService.postAdjustment({
        userId: moneyAdjustment.userId,
        amountMinorUnits: moneyAdjustment.amountMinorUnits,
        direction: moneyAdjustment.direction,
        reason: resolutionText,
        reference: `dispute:${caseId}`,
        actorId: callerId
      });
    } catch (error) {
      throw new DisputeAdjustmentError(
        `Decision recorded but money adjustment failed (${error.message}); retry via POST /admin/ledger/adjustments with reference dispute:${caseId}`
      );
    }
  }

  return {
    disputeCase: decidedResult.updated,
    correction: decidedResult.correction,
    adjustment
  };
};