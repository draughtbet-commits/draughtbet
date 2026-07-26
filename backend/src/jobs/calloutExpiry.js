import cron from 'node-cron';
import prisma from '../utils/db.js';
import logger from '../utils/logger.js';

let isSweeping = false;

export const processCalloutExpiry = async () => {
  if (isSweeping) return;
  isSweeping = true;

  try {
    // Atomic update to expire callouts
    const result = await prisma.$executeRaw`
      UPDATE "Callout"
      SET status = 'EXPIRED'
      WHERE status = 'OPEN' AND "expiresAt" < NOW()
    `;
    
    if (result > 0) {
      logger.info({ expiredCount: result }, 'Expired stale callouts');
    }
  } catch (err) {
    logger.error({ err }, 'Error during callout expiry sweep');
  } finally {
    isSweeping = false;
  }
};

export const startCalloutExpirySweep = () => {
  // Run every minute
  cron.schedule('* * * * *', () => {
    processCalloutExpiry();
  });
  logger.info('Callout expiry sweep started');
};
