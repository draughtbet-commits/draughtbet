import cron from 'node-cron';
import prisma from '../utils/db.js';
import logger from '../utils/logger.js';
import { OPEN_MATCH_TTL_MS } from '../modules/v2/lifecycleService.js';
import { transitionMatch } from '../modules/match/service.js';
import {
  clearPrePlayState,
  notifyPrePlayReleased,
} from '../sockets/prePlayNotifier.js';

/**
 * Retires OPEN listings whose TTL elapsed without an opponent. An OPEN listing
 * reserves no stake until someone joins, so there is nothing to refund — but
 * leaving it OPEN lets a private room sit on the creator's Home for ever and
 * lets a stale Arena entry be challenged after its window closed. The lazy TTL
 * in `fundOpenMatchTx` already refuses a late join; this sweep makes the
 * cancellation authoritative and observable.
 *
 * Directed challenges are an OPEN match with a pending challenge row; the
 * challenge sweep owns those (it also expires the challenge itself), so they
 * are excluded here to keep one writer per match.
 */
export const processOpenMatchExpirySweep = async ({
  now = Date.now(),
  ttlMs = OPEN_MATCH_TTL_MS,
} = {}) => {
  const threshold = new Date(now - ttlMs);
  const rows = await prisma.match.findMany({
    where: {
      status: 'OPEN',
      createdAt: { lt: threshold },
      challenges: { none: { status: 'PENDING' } },
    },
    orderBy: { createdAt: 'asc' },
    take: 50,
    select: { id: true, playerLightId: true, playerDarkId: true },
  });

  let expired = 0;
  for (const row of rows) {
    try {
      const didExpire = await prisma.$transaction(async (tx) => {
        const match = await tx.match.findUnique({
          where: { id: row.id },
          select: { status: true },
        });
        if (!match || match.status !== 'OPEN') return false;
        await transitionMatch(tx, row.id, 'EXPIRED');
        return true;
      });
      if (!didExpire) continue;
      expired++;
      const playerIds = [row.playerLightId, row.playerDarkId];
      // Best-effort teardown: a stale activeMatch pointer would resurrect the
      // retired room on the creator's next cold start.
      await clearPrePlayState(row.id, playerIds);
      notifyPrePlayReleased({
        matchId: row.id,
        playerIds,
        reason: 'open_match_expired',
        status: 'EXPIRED',
        refunded: false,
      });
      logger.info({ matchId: row.id }, 'Open match expiry — listing retired');
    } catch (err) {
      logger.error({ err, matchId: row.id }, 'Open match expiry failed for a match');
    }
  }
  return { scanned: rows.length, expired };
};

export const startOpenMatchExpirySweep = () => {
  cron.schedule('*/30 * * * * *', () => {
    processOpenMatchExpirySweep();
  });
  logger.info('Open match expiry sweep started');
};
