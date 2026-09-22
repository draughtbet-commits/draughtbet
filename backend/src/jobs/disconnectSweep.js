import redis, { isRedisReady } from '../utils/redis.js';
import prisma from '../utils/db.js';
import { getIO } from '../sockets/index.js';
import logger from '../utils/logger.js';
import { getOpponentId } from '../sockets/gameManager.js';
import { settleGameWithRetry, settleGameDrawWithRetry } from '../sockets/settlement.js';
import { isLiveStatus } from '../modules/match/service.js';
import { recordGameEvent } from '../sockets/connectionEvidence.js';
import cron from 'node-cron';

// A known server incident suspends player-forfeit decisions entirely; entries
// stay queued and are re-evaluated once the incident is cleared.
const forfeitsSuspended = () => process.env.GAME_FORFEIT_SUSPENDED === 'true';

export const processDisconnectSweep = async ({ now = Date.now() } = {}) => {
  if (forfeitsSuspended()) {
    logger.warn('Disconnect sweep suspended: forfeits are paused during a server incident');
    return { processed: 0, suspended: true };
  }

  let expired;
  try {
    expired = await redis.zrangebyscore('disconnects', '-inf', now);
  } catch (err) {
    logger.error({ err }, 'Disconnect sweep: failed to read expired entries');
    return { processed: 0, suspended: false };
  }

  let processed = 0;
  for (const entry of expired) {
    // Each iteration has its own try/catch so one failure never prevents
    // processing of remaining expired entries.
    try {
      const [matchId, disconnectedUserId] = entry.split(':');

      // Remove from the sorted set FIRST (prevents the next tick from re-processing).
      const removed = await redis.zrem('disconnects', entry);
      if (removed === 0) continue; // Another tick or reconnect already handled it

      // TOCTOU guard: has the player reconnected since we read the set?
      const io = getIO();
      const roomSockets = await io.in(`match:${matchId}`).fetchSockets();
      if (roomSockets.some((s) => s.user?.userId === disconnectedUserId)) {
        logger.info({ matchId, userId: disconnectedUserId },
          'Disconnect sweep: player reconnected before forfeit — skipping');
        continue;
      }

      // Forfeit is only valid while the match is actually live. A match that
      // ended or was released meanwhile is never settled from here.
      const match = await prisma.match.findUnique({
        where: { id: matchId },
        select: { status: true }
      });
      if (!match || !isLiveStatus(match.status)) {
        logger.info({ matchId, status: match?.status },
          'Disconnect sweep: match no longer live — skipping forfeit');
        continue;
      }

      const opponentId = await getOpponentId(matchId, disconnectedUserId);
      if (!opponentId) {
        logger.warn({ matchId, userId: disconnectedUserId },
          'Disconnect sweep: cannot resolve opponent — skipping');
        continue;
      }

      const otherDisconnect = await redis.zscore('disconnects', `${matchId}:${opponentId}`);
      if (otherDisconnect !== null) {
        // Both players disconnected — draw refund, not an arbitrary forfeit.
        await redis.zrem('disconnects', `${matchId}:${opponentId}`);
        logger.info({ matchId }, 'Both players disconnected — settling as draw');
        await recordGameEvent({
          matchId,
          type: 'FORFEIT',
          payload: { reason: 'both_disconnected', players: [disconnectedUserId, opponentId] }
        });
        await settleGameDrawWithRetry(matchId, 'both_disconnected');
      } else {
        logger.info({ matchId, forfeitedBy: disconnectedUserId, winner: opponentId },
          'Disconnect timeout — auto-forfeit');
        await recordGameEvent({
          matchId,
          playerId: disconnectedUserId,
          type: 'FORFEIT',
          payload: { reason: 'forfeit_disconnect', opponentId }
        });
        await settleGameWithRetry(matchId, opponentId, disconnectedUserId, 'forfeit_disconnect');
      }
      processed++;
    } catch (err) {
      logger.error({ err, entry }, 'Disconnect sweep: error processing entry, continuing');
    }
  }
  return { processed, suspended: false };
};

export const startDisconnectSweep = () => {
  cron.schedule('*/10 * * * * *', async () => {
    if (!isRedisReady()) return;
    await processDisconnectSweep();
  });
  logger.info('Started disconnect sweep job');
};
