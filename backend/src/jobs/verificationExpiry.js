import cron from 'node-cron';
import { expireStaleVerificationCases } from '../modules/verification/service.js';
import logger from '../utils/logger.js';

let isSweeping = false;

export const processVerificationExpiry = async () => {
  if (isSweeping) return;
  isSweeping = true;

  try {
    // An attempt whose provider never answered would otherwise hold the player
    // in a permanent pending state, and the in-flight guard would refuse every
    // further attempt -- locking them out of withdrawals with no way back.
    const { expired, recovered } = await expireStaleVerificationCases();
    if (recovered > 0) {
      logger.info({ recovered }, 'Recovered verification attempts the webhook missed');
    }
    if (expired > 0) {
      logger.info({ expired }, 'Expired stale verification attempts');
    }
  } catch (err) {
    logger.error({ err }, 'Error during verification expiry sweep');
  } finally {
    isSweeping = false;
  }
};

export const startVerificationExpirySweep = () => {
  // Hourly. The attempt TTL is measured in hours, so the sweep only has to be
  // frequent enough that nobody waits a noticeable extra time to be unblocked.
  cron.schedule('17 * * * *', () => {
    processVerificationExpiry();
  });
  logger.info('Verification expiry sweep started');
};