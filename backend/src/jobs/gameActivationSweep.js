import cron from 'node-cron';
import prisma from '../utils/db.js';
import logger from '../utils/logger.js';
import { finalizeMatchActivation, releaseMatch, MAX_ACTIVATION_ATTEMPTS } from '../services/gameActivationService.js';

/**
 * Repairs matches whose funding committed but whose game was never made
 * playable (the original process died between the DB commit and the Redis
 * init). Each pass replays PENDING records and reclaims ACTIVATING records
 * whose claim lease has expired. A record that keeps failing exhausts its
 * attempts and is released instead — both stakes refunded exactly once.
 */
export const processGameActivationSweep = async () => {
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
};

export const startGameActivationSweep = () => {
  cron.schedule('*/3 * * * * *', () => {
    processGameActivationSweep();
  });
  logger.info('Game activation sweep started');
};