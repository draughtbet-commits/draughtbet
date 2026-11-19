import cron from 'node-cron';
import prisma from '../utils/db.js';
import logger from '../utils/logger.js';
import { finalizeMatchActivation, releaseMatch, MAX_ACTIVATION_ATTEMPTS } from '../services/gameActivationService.js';

const BASE_BACKOFF_MS = 3_000;
const MAX_BACKOFF_MS = 60_000;
let isSweeping = false;

/**
 * Repairs matches whose funding committed but whose game was never made
 * playable (the original process died between the DB commit and the Redis
 * init). Each pass replays PENDING records and reclaims ACTIVATING records
 * whose claim lease has expired. A record that keeps failing exhausts its
 * attempts and is released instead — both stakes refunded exactly once.
 */
export const processGameActivationSweep = async () => {
  if (isSweeping) return { skipped: true };
  isSweeping = true;

  try {
    const rows = await prisma.gameOutbox.findMany({
      where: {
        status: { in: ['PENDING', 'ACTIVATING'] },
        OR: [{ claimExpiresAt: null }, { claimExpiresAt: { lt: new Date() } }]
      },
      orderBy: { createdAt: 'asc' },
      take: 50
    });

    for (const row of rows) {
      try {
        if (row.attempts >= MAX_ACTIVATION_ATTEMPTS) {
          await releaseMatch(row.id);
        } else {
          await finalizeMatchActivation(row.id);
        }
      } catch (err) {
        logger.error({ err, outboxId: row.id, matchId: row.matchId }, 'Activation sweep failed for an outbox record');
      }
    }
    return { ok: true, scanned: rows.length };
  } catch (err) {
    logger.error({ err }, 'Error during game activation sweep');
    return { ok: false, error: err };
  } finally {
    isSweeping = false;
  }
};

export const startGameActivationSweep = () => {
  let consecutiveFailures = 0;
  let nextAllowedRunAt = 0;

  const task = cron.schedule('*/3 * * * * *', async () => {
    const now = Date.now();
    if (now < nextAllowedRunAt) return;

    const result = await processGameActivationSweep();
    if (result?.skipped) return;

    if (result?.ok) {
      consecutiveFailures = 0;
      nextAllowedRunAt = 0;
    } else {
      consecutiveFailures = Math.min(consecutiveFailures + 1, 6);
      const backoffMs = Math.min(BASE_BACKOFF_MS * (2 ** (consecutiveFailures - 1)), MAX_BACKOFF_MS);
      nextAllowedRunAt = Date.now() + backoffMs;
      logger.warn(
        { consecutiveFailures, backoffMs },
        'Game activation sweep backing off after transient error'
      );
    }
  });
  logger.info('Game activation sweep started');
  return task;
};