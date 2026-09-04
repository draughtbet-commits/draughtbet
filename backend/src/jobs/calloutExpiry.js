import cron from 'node-cron';
import prisma from '../utils/db.js';
import logger from '../utils/logger.js';

let isSweeping = false;

export const processCalloutExpiry = async () => {
  if (isSweeping) return;
  isSweeping = true;

  try {
    // Atomic update to expire callouts using Prisma ORM
    const result = await prisma.callout.updateMany({
      where: {
        status: 'OPEN',
        expiresAt: { lt: new Date() },
      },
      data: {
        status: 'EXPIRED',
      },
    });
    
    if (result.count > 0) {
      logger.info({ expiredCount: result.count }, 'Expired stale callouts');
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
