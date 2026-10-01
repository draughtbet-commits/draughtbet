import redis from '../utils/redis.js';
import logger from '../utils/logger.js';
import { getIO } from './index.js';

/**
 * Pre-play teardown side effects shared by every path that ends a match before
 * it goes live (REST cancel, challenge decline, ready-gate timeout).
 *
 * Both halves matter:
 *
 *  1. Redis holds the live-state projection and each player's activeMatch
 *     pointer. Those are what `GET /matches/active` and socket reconnection read
 *     to decide a client belongs to a match, so leaving them behind lets a
 *     cancelled match be resurrected as a phantom on the next cold start.
 *
 *  2. The socket is the only way the non-initiating player learns the match is
 *     over. A teardown that touches only Postgres and Redis leaves a client
 *     sitting in the pre-match room waiting for authoritative state that will
 *     never arrive.
 *
 * `status` and `refunded` are taken from the teardown result rather than assumed:
 * a DRAFT/OPEN match is cancelled without a refund, while FUNDED/READY is
 * released with one, and the client is told which happened.
 */
export const clearPrePlayState = async (matchId, playerIds) => {
  try {
    await redis.del(`match:${matchId}`);
    for (const userId of playerIds) {
      if (userId) await redis.del(`user:${userId}:activeMatch`);
    }
  } catch (err) {
    // Never fail a completed teardown over cache cleanup: the ledger refund has
    // already committed, and throwing here would report a success as an error.
    logger.warn({ err, matchId }, 'Pre-play teardown: Redis cleanup failed');
  }
};

export const notifyPrePlayReleased = ({
  matchId,
  playerIds,
  reason,
  status,
  refunded,
  cancelledBy = null,
}) => {
  try {
    const io = getIO();
    if (!io) return;
    const payload = {
      matchId,
      reason,
      terminalReason: reason,
      endReason: reason,
      refunded: Boolean(refunded),
      status,
      ...(cancelledBy ? { cancelledBy } : {})
    };
    io.to(`match:${matchId}`).emit('match_preplay_released', payload);
    for (const userId of playerIds) {
      if (userId) io.to(`user:${userId}`).emit('match_preplay_released', payload);
    }
  } catch (err) {
    logger.warn({ err, matchId }, 'Pre-play teardown: release notify failed');
  }
};