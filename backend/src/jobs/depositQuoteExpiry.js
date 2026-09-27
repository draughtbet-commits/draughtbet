import cron from 'node-cron';
import { expireDepositQuotes } from '../modules/wallet/service.js';
import logger from '../utils/logger.js';

let isSweeping = false;

export const processDepositQuoteExpiry = async () => {
  if (isSweeping) return;
  isSweeping = true;

  try {
    // Quotes past their TTL can never be claimed, so retiring them is pure
    // hygiene: it keeps the table bounded and stops an expired quote reading as
    // "still active" to anyone inspecting it. The sweep is a single bounded
    // UPDATE, so it is idempotent and safe to re-run after a crash.
    const expiredCount = await expireDepositQuotes();
    if (expiredCount > 0) {
      logger.info({ expiredCount }, 'Expired stale deposit quotes');
    }
  } catch (err) {
    logger.error({ err }, 'Error during deposit quote expiry sweep');
  } finally {
    isSweeping = false;
  }
};

export const startDepositQuoteExpirySweep = () => {
  // Every five minutes. Quote TTLs are minutes long, so this only has to be
  // prompt enough that a table scan never sees a large backlog.
  cron.schedule('*/5 * * * *', () => {
    processDepositQuoteExpiry();
  });
  logger.info('Deposit quote expiry sweep started');
};
