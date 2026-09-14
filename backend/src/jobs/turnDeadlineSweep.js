import redis, { isRedisReady } from '../utils/redis.js';
import logger from '../utils/logger.js';
import { settleGameWithRetry } from '../sockets/settlement.js';
import { TURN_EXPIRED_REASON } from '../sockets/timeControl.js';
import cron from 'node-cron';

// Inspect up to this many match keys per SCAN round.
const SWEEP_PAGE_SIZE = 100;

/**
 * Finds every live game whose current turn's deadline has passed and forfeits
 * the player on the clock. The Redis hash is the authoritative deadline source
 * (managed atomically by the gameManager CAS script), and `settleGameWithRetry`
 * carries the same atomic DB gate the live handlers use — a racing move loss or
 * win settles exactly once either way.
 *
 * Exported for tests; the scheduled wrapper no-ops while Redis is down.
 */
export const processTurnDeadlineSweep = async ({ now = Date.now(), pageSize = SWEEP_PAGE_SIZE } = {}) => {
  const expired = [];
  let cursor = '0';

  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'match:*', 'COUNT', pageSize);
    cursor = nextCursor;
    for (const key of keys) {
      const state = await redis.hgetall(key);
      if (!state || Object.keys(state).length === 0) continue;
      if (state.status !== 'in_progress') continue;
      const deadline = Number(state.deadlineAt);
      if (!Number.isFinite(deadline) || deadline <= 0) continue;
      if (now <= deadline) continue;
      expired.push({ matchId: key.slice('match:'.length), state });
    }
  } while (cursor !== '0');

  const settled = [];
  for (const { matchId, state } of expired) {
    try {
      // Each match has its own try/catch so one failure never blocks the batch.
      const loserId = state.currentTurnUserId;
      const winnerId = state.player1 === loserId ? state.player2 : state.player1;
      if (!winnerId) {
        logger.warn({ matchId }, 'Turn deadline sweep: cannot resolve opponent, skipping');
        continue;
      }
      logger.info({ matchId, forfeitedBy: loserId, winner: winnerId },
        'Turn deadline — auto-forfeit');
      await settleGameWithRetry(matchId, winnerId, loserId, TURN_EXPIRED_REASON);
      settled.push(matchId);
    } catch (err) {
      logger.error({ err, matchId }, 'Turn deadline sweep: settlement failed, continuing');
    }
  }
  return { expired, settled };
};

export const startTurnDeadlineSweep = () => {
  cron.schedule('*/5 * * * * *', async () => {
    if (!isRedisReady()) return;
    try {
      await processTurnDeadlineSweep();
    } catch (err) {
      logger.error({ err }, 'Turn deadline sweep: iteration failed');
    }
  });
  logger.info('Started turn deadline sweep job');
};