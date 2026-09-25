import cron from 'node-cron';
import prisma from '../utils/db.js';
import logger from '../utils/logger.js';
import { OPEN_MATCH_TTL_MS } from '../modules/v2/lifecycleService.js';
import { transitionMatch } from '../modules/match/service.js';

/**
 * Proactively expires sent-but-unanswered challenges once the open-match TTL
 * elapses. Today the pending-challenge window is enforced lazily inside
 * fundOpenMatch (a late join is refused as EXPIRED); this sweep makes the
 * terminal state visible to the inviter, whose app polls the match lifecycle
 * and surfaces the challenge-expired screen when the server owns the state.
 *
 * Only OPEN matches with a still-PENDING directed challenge are touched.
 * Funding (join) already transitioned the challenge to ACCEPTED, so a funded
 * match is never raced here: the query filters on OPEN + PENDING only.
 */
export const processChallengeExpirySweep = async ({
  now = Date.now(),
  ttlMs = OPEN_MATCH_TTL_MS
} = {}) => {
  const threshold = new Date(now - ttlMs);
  const rows = await prisma.matchChallenge.findMany({
    where: {
      status: 'PENDING',
      createdAt: { lt: threshold }
    },
    orderBy: { createdAt: 'asc' },
    take: 50,
    select: { id: true, matchId: true }
  });

  let expired = 0;
  for (const row of rows) {
    const matchId = row.matchId;
    try {
      const didExpire = await prisma.$transaction(async (tx) => {
        const match = await tx.match.findUnique({
          where: { id: matchId },
          select: { status: true }
        });
        if (!match || match.status !== 'OPEN') return false;
        await transitionMatch(tx, matchId, 'EXPIRED');
        await tx.matchChallenge.updateMany({
          where: { matchId, status: 'PENDING' },
          data: { status: 'EXPIRED' }
        });
        return true;
      });
      if (didExpire) {
        expired++;
        logger.info({ matchId }, 'Challenge expiry — pending challenge expired');
      }
    } catch (err) {
      logger.error({ err, matchId }, 'Challenge expiry failed for a match');
    }
  }
  return { scanned: rows.length, expired };
};

export const startChallengeExpirySweep = () => {
  cron.schedule('*/30 * * * * *', () => {
    processChallengeExpirySweep();
  });
  logger.info('Challenge expiry sweep started');
};