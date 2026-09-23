import redis, { isRedisReady } from '../utils/redis.js';
import prisma from '../utils/db.js';
import logger from '../utils/logger.js';
import { settleGameWithRetry, settleGameDrawWithRetry } from '../sockets/settlement.js';
import { reconcileRedisWithDurable } from '../sockets/gameRecovery.js';
import { LIVE_STATUSES } from '../modules/match/service.js';
import cron from 'node-cron';

/**
 * One sweep pass over matches Postgres thinks are still live:
 *   - Redis says the match ended but PG is still live (split brain): settle.
 *   - Redis state is missing entirely: rebuild the projection from the durable
 *     move log; if the rebuilt projection is terminal, settle — otherwise leave
 *     the live match alone and only warn once it is virgin-stale (no durable
 *     record either).
 *   - Redis agrees it's live: no-op.
 * Every match is fault-isolated so one bad row never aborts the sweep, and
 * settling funnels through the idempotent settlement gate (retried commits are
 * safe). Restart-safe: any progress is durable in PG, so a killed sweep resumes
 * cleanly next pass.
 */
async function resolveTerminalState(match, state) {
  if (state.status === 'completed') {
    const winnerId = state.winnerId;
    if (!winnerId) {
      logger.error({ matchId: match.id }, 'CRITICAL: Redis says completed but winnerId is missing.');
      return false;
    }
    const loserId = winnerId === match.playerLightId ? match.playerDarkId : match.playerLightId;
    await settleGameWithRetry(match.id, winnerId, loserId, 'recovery_sweep');
    return true;
  }
  if (state.status === 'draw') {
    await settleGameDrawWithRetry(match.id, 'recovery_sweep_draw');
    return true;
  }
  return false;
}

export async function processReconciliationSweep({ now = () => Date.now() } = {}) {
  const activeMatches = await prisma.match.findMany({
    where: { status: { in: LIVE_STATUSES } },
    select: { id: true, playerLightId: true, playerDarkId: true, createdAt: true }
  });

  const outcome = { scanned: activeMatches.length, splitBrain: 0, rebuilt: 0, errored: 0 };
  for (const match of activeMatches) {
    try {
      const state = await redis.hgetall(`match:${match.id}`);
      const hasLive = state && Object.keys(state).length > 0;

      if (hasLive) {
        if (await resolveTerminalState(match, state)) outcome.splitBrain++;
        continue;
      }

      // Redis projection missing: try to rebuild it from the durable log.
      const rebuilt = await reconcileRedisWithDurable(match.id);
      if (rebuilt && Object.keys(rebuilt).length > 0) {
        outcome.rebuilt++;
        if (await resolveTerminalState(match, rebuilt)) outcome.splitBrain++;
        continue;
      }

      // Nothing in Redis and nothing durable to rebuild from: a live match that
      // exists only as a PG row. Log an alert once it's been stuck for a while.
      const ageHours = (now() - new Date(match.createdAt).getTime()) / (1000 * 60 * 60);
      if (ageHours > 12) {
        logger.warn({ matchId: match.id, ageHours }, 'Reconciliation sweep: stale ACTIVE match found in PG but no Redis state.');
      }
    } catch (err) {
      outcome.errored++;
      logger.error({ err, matchId: match.id }, 'Reconciliation sweep: match failed; continuing');
    }
  }

  if (activeMatches.length > 0) {
    logger.info(outcome, 'Reconciliation sweep complete');
  }
  return outcome;
}

let isSweeping = false;

export const startReconciliationSweep = () => {
  // Run every 5 minutes
  return cron.schedule('*/5 * * * *', async () => {
    if (!isRedisReady()) return;
    if (isSweeping) return;
    isSweeping = true;
    try {
      await processReconciliationSweep();
    } catch (err) {
      logger.error({ err }, 'Error in reconciliation sweep job');
    } finally {
      isSweeping = false;
    }
  });
};