import cron from 'node-cron';
import prisma from '../utils/db.js';
import logger from '../utils/logger.js';
import { clearPrePlayState, notifyPrePlayReleased } from '../sockets/prePlayNotifier.js';
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
 *
 * The sweep is not a request/response path, so nothing else tells a waiting
 * client a release happened; it therefore performs the same Redis and socket
 * teardown as an explicit cancel.
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
      const result = await cancelPreplayMatch(row.id, { endReason: 'ready_gate_timeout' });
      released++;
      const playerIds = [row.playerLightId, row.playerDarkId];
      // Best-effort live-state cleanup: the stale holding projection (and any
      // activeMatch pointers) must not outlive a released match.
      await clearPrePlayState(row.id, playerIds);
      notifyPrePlayReleased({
        matchId: row.id,
        playerIds,
        reason: 'ready_gate_timeout',
        status: result?.status ?? 'RELEASED',
        refunded: result?.refunded ?? true
      });
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