import redis from '../utils/redis.js';
import prisma from '../utils/db.js';
import logger from '../utils/logger.js';
import { settleGameWithRetry, settleGameDrawWithRetry } from '../sockets/settlement.js';
import cron from 'node-cron';

export const startReconciliationSweep = () => {
  // Run every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    try {
      // Find matches that Postgres thinks are still active
      const activeMatches = await prisma.match.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, playerLightId: true, playerDarkId: true, createdAt: true }
      });

      for (const match of activeMatches) {
        // Look up the corresponding Redis state
        const state = await redis.hgetall(`match:${match.id}`);
        
        if (state && Object.keys(state).length > 0) {
          if (state.status === 'completed' || state.status === 'draw') {
            // SPLIT BRAIN DETECTED
            logger.info({ matchId: match.id, status: state.status }, 'Reconciliation sweep: resolving split-brain match');
            
            if (state.status === 'completed') {
              const winnerId = state.winnerId;
              
              if (!winnerId) {
                  logger.error({ matchId: match.id }, 'CRITICAL: Redis says completed but winnerId is missing.');
                  continue; // Require manual intervention
              }
              
              const loserId = winnerId === match.playerLightId ? match.playerDarkId : match.playerLightId;
              await settleGameWithRetry(match.id, winnerId, loserId, 'recovery_sweep');
            } else {
              await settleGameDrawWithRetry(match.id, 'recovery_sweep_draw');
            }
          }
        } else {
          // If Redis is empty but Match is ACTIVE, it might be an orphaned game
          // If it's older than 12 hours, log an alert
          const ageHours = (Date.now() - new Date(match.createdAt).getTime()) / (1000 * 60 * 60);
          if (ageHours > 12) {
            logger.warn({ matchId: match.id, ageHours }, 'Reconciliation sweep: stale ACTIVE match found in PG but no Redis state.');
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in reconciliation sweep job');
    }
  });
  logger.info('Started reconciliation sweep job');
};
