import cron from 'node-cron';
import prisma from '../utils/db.js';
import redis from '../utils/redis.js';
import logger from '../utils/logger.js';
import { cancelPreplayMatch } from '../services/gameActivationService.js';

// A funded match that never reaches both-players-ready within the timeout is
// released: both stakes are refunded exactly once (cancelPreplayMatch). The
// timeout is deliberately generous — real money is at stake and a player may
// join the match room many seconds after funding.
export const READY_GATE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.READY_GATE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15 * 60 * 1000;
})();

/**
 * Releases FUNDED/READY matches whose pre-play window elapsed. Never touches a
 * live match (cancelPreplayMatch refuses IN_PLAY), and each release is guarded
 * by the same idempotency as the REST cancel path — refunds happen exactly once.
 */
export const processReadyGateSweep = async ({ now = Date.now(), timeoutMs = READY_GATE_TIMEOUT_MS } = {}) => {
  const threshold = new Date(now - timeoutMs);
  const rows = await prisma.match.findMany({
    where: {
      status: { in: ['FUNDED', 'READY'] },
      createdAt: { lt: threshold }
    },
    orderBy: { createdAt: 'asc' },
    take: 50,
    select: { id: true, playerLightId: true, playerDarkId: true }
  });

  let released = 0;
  for (const row of rows) {
    try {
      await cancelPreplayMatch(row.id);
      released++;
      // Best-effort live-state cleanup: the stale holding projection (and any
      // activeMatch pointers) must not outlive a released match.
      try {
        await redis.del(`match:${row.id}`);
        await redis.del(`user:${row.playerLightId}:activeMatch`);
        await redis.del(`user:${row.playerDarkId}:activeMatch`);
      } catch (err) {
        logger.warn({ err, matchId: row.id }, 'Ready gate sweep: Redis cleanup failed');
      }
      logger.info({ matchId: row.id }, 'Ready gate timeout — pre-play match released, stakes refunded');
    } catch (err) {
      logger.error({ err, matchId: row.id }, 'Ready gate sweep failed for a match');
    }
  }
  return { scanned: rows.length, released };
};

export const startReadyGateSweep = () => {
  cron.schedule('*/45 * * * * *', () => {
    processReadyGateSweep();
  });
  logger.info('Ready gate sweep started');
};