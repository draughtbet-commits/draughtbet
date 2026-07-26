import redis from '../utils/redis.js';
import { getIO } from '../sockets/index.js';
import logger from '../utils/logger.js';
import { getOpponentId } from '../sockets/gameManager.js';
import { settleGameWithRetry, settleGameDrawWithRetry } from '../sockets/settlement.js';
import cron from 'node-cron';

export const startDisconnectSweep = () => {
  cron.schedule('*/10 * * * * *', async () => {
    let expired;
    try {
      // 1. Pop all expired entries (score < now)
      expired = await redis.zrangebyscore('disconnects', '-inf', Date.now());
    } catch (err) {
      logger.error({ err }, 'Disconnect sweep: failed to read expired entries');
      return;
    }

    for (const entry of expired) {
      // Each iteration has its own try/catch so one failure
      // never prevents processing of remaining expired entries.
      try {
        const [matchId, disconnectedUserId] = entry.split(':');

        // 2. Remove from sorted set FIRST (prevents next tick from re-processing)
        const removed = await redis.zrem('disconnects', entry);
        if (removed === 0) continue; // Another tick or reconnect already handled it

        // 3. TOCTOU guard: check if the player has reconnected since we read the set
        const io = getIO();
        const roomSockets = await io.in(`match:${matchId}`).fetchSockets();
        const isReconnected = roomSockets.some(s => s.user?.userId === disconnectedUserId);

        if (isReconnected) {
          logger.info({ matchId, userId: disconnectedUserId },
            'Disconnect sweep: player reconnected before forfeit — skipping');
          continue;
        }

        // 4. Check for BOTH players disconnected
        const opponentId = await getOpponentId(matchId, disconnectedUserId);
        const otherDisconnect = await redis.zscore('disconnects', `${matchId}:${opponentId}`);

        if (otherDisconnect !== null) {
          // Both players disconnected — draw refund, not arbitrary forfeit
          await redis.zrem('disconnects', `${matchId}:${opponentId}`);
          logger.info({ matchId }, 'Both players disconnected — settling as draw');
          await settleGameDrawWithRetry(matchId, 'both_disconnected');
          continue;
        }

        // 5. Single disconnect forfeit — disconnected player loses
        logger.info({ matchId, forfeitedBy: disconnectedUserId, winner: opponentId },
          'Disconnect timeout — auto-forfeit');
        await settleGameWithRetry(matchId, opponentId, disconnectedUserId, 'forfeit_disconnect');
      } catch (err) {
        // Log and continue to the next entry — never let one failure
        // blow up the entire batch.
        logger.error({ err, entry }, 'Disconnect sweep: error processing entry, continuing');
      }
    }
  });
  logger.info('Started disconnect sweep job');
};
