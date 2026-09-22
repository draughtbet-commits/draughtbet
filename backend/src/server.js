import 'dotenv/config';
import app from './app.js';
import logger from './utils/logger.js';
import cron from 'node-cron';
import { initSocketServer } from './sockets/index.js';
import { waitForRateLimitRedis } from './middleware/rateLimit.js';
import { startDisconnectSweep } from './jobs/disconnectSweep.js';
import { startReconciliationSweep } from './jobs/reconciliationSweep.js';
import { startMatchmakingWorker } from './jobs/matchmakingWorker.js';
import { startCalloutExpirySweep } from './jobs/calloutExpiry.js';
import { startGameActivationSweep } from './jobs/gameActivationSweep.js';
import { startTurnDeadlineSweep } from './jobs/turnDeadlineSweep.js';
import { startDepositReconciliationSweep } from './jobs/depositReconciliation.js';
import { startOutboxDrainer } from './jobs/outboxDrainer.js';
import { startProviderFollowUp } from './jobs/providerFollowUp.js';
import { startFinancialReconciliation } from './jobs/financialReconciliation.js';
import { startGameRecovery } from './sockets/gameRecovery.js';
import { startReadyGateSweep } from './jobs/readyGateSweep.js';

const PORT = process.env.PORT || 3000;

// All background jobs start from the process bootstrap, never from importing
// app.js (importing the app must stay side-effect-free so tests and tooling
// can load it without spawning sweeps). Every job is idempotent and
// restart-safe, so a kill mid-run is recovered on next boot.
const startBackgroundJobs = () => {
  startDisconnectSweep();
  startReconciliationSweep();
  startMatchmakingWorker();
  startCalloutExpirySweep();
  startGameActivationSweep();
  startTurnDeadlineSweep();
  startDepositReconciliationSweep();
  startOutboxDrainer();
  startProviderFollowUp();
  startFinancialReconciliation();
  startGameRecovery();
  startReadyGateSweep();
};

// Wait (bounded) for Redis so the shared rate limiter is in service before the
// first request. Degrades to per-process memory if Redis is not reachable.
await waitForRateLimitRedis();

const server = app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);
});

// Initialize Socket.IO
initSocketServer(server);

// Start background jobs AFTER the server and socket layer are up.
startBackgroundJobs();

// Graceful shutdown: stop the cron sweeps (they are all restart-safe — every
// sweep is idempotent, cheap to re-run and carries no in-memory state that
// would be lost), then close the HTTP server and exit. Committed money/events
// are never at risk: a kill mid-sweep is recovered on the next boot by the
// same sweeps.
let shuttingDown = false;
const shutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} signal received: stopping jobs and closing HTTP server`);
  try {
    cron.getTasks().forEach((task) => task?.stop?.());
  } catch (err) {
    logger.warn({ err }, 'Failed to stop cron jobs during shutdown');
  }
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
  // Safety net: never hang the container on a stalled connection.
  setTimeout(() => process.exit(0), 5000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
