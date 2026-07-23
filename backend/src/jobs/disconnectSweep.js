import redis from '../utils/redis.js';
import { getIO } from '../sockets/index.js';
import logger from '../utils/logger.js';
import { getOpponentId } from '../sockets/gameManager.js';
import { settleGame, settleGameDraw } from '../sockets/settlement.js';
import cron from 'node-cron';

export const startDisconnectSweep = () => {
  cron.schedule('*/10 * * * * *', async () => {
    try {
      // 1. Pop all expired entries (score < now)
      const expired = await redis.zrangebyscore('disconnects', '-inf', Date.now());

      for (const entry of expired) {
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
          await settleGameDraw(matchId, 'both_disconnected');
          continue;
        }

        // 5. Single disconnect forfeit — disconnected player loses
        logger.info({ matchId, forfeitedBy: disconnectedUserId, winner: opponentId },
          'Disconnect timeout — auto-forfeit');
        await settleGame(matchId, opponentId, disconnectedUserId, 'forfeit_disconnect');
      }
    } catch (err) {
      logger.error({ err }, 'Error in disconnect sweep job');
    }
  });
  logger.info('Started disconnect sweep job');
};
