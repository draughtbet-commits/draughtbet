import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import logger, { httpLogger } from './utils/logger.js';
import prisma from './utils/db.js';
import Redis from 'ioredis';
import {
  globalRateLimiter,
  adminRateLimiter,
  withdrawalRateLimiter,
  depositRateLimiter,
  verificationRateLimiter,
  saferPlayRateLimiter,
  walletRateLimiter,
  matchRateLimiter,
  calloutRateLimiter,
  matchmakingRateLimiter,
  notificationRateLimiter
} from './middleware/rateLimit.js';
import { requestIdMiddleware, finalErrorHandler } from './middleware/requestId.js';
import { authRouter } from './modules/auth/controller.js';
import { adminRouter } from './modules/admin/controller.js';
import { matchRouter } from './modules/match/controller.js';
import { calloutRouter } from './modules/callout/controller.js';
import { matchmakingRouter } from './modules/matchmaking/controller.js';
import { walletRouter } from './modules/wallet/controller.js';
import { webhookRouter } from './modules/payment/webhookController.js';
import { notificationRouter } from './modules/notification/controller.js';
import { verificationRouter } from './modules/verification/controller.js';
import { saferPlayRouter } from './modules/saferPlay/controller.js';
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

const app = express();
// Prisma initialized in utils/db.js

// Rate limiting and TLS checks key off req.ip / req.secure, so the number of
// trusted proxy hops must be explicit behind a load balancer. Off by default
// outside production; in production default to one hop (adjust TRUST_PROXY).
const trustProxyRaw = process.env.TRUST_PROXY ?? (process.env.NODE_ENV === 'production' ? '1' : 'false');
const trustProxy = trustProxyRaw === 'true' ? true : (parseInt(trustProxyRaw, 10) || false);
app.set('trust proxy', trustProxy);

// Setup Redis correctly
let redis;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL);
}

// Global middlewares
app.use(helmet());
const corsOrigin = process.env.ADMIN_CORS_ORIGIN;
if (!corsOrigin && process.env.NODE_ENV === 'production') {
  throw new Error('FATAL: ADMIN_CORS_ORIGIN is missing. Refusing to start with open CORS.');
}
// Allow open CORS in tests (so imports/startup don't fail) and use a sensible default in dev
const corsOptions = corsOrigin
  ? { origin: (origin, done) => done(null, origin === corsOrigin ? corsOrigin : false) }
  : (process.env.NODE_ENV === 'test' ? { origin: true } : { origin: 'http://localhost:3000' });
app.use(cors(corsOptions));

// TLS enforcement for production fronting (APP_ENFORCE_TLS=true). HTTP GET/HEAD
// are 301-redirected to HTTPS; non-idempotent methods are refused outright so a
// plaintext body is never accepted. Health checks are exempt so LBs can probe.
if (process.env.APP_ENFORCE_TLS === 'true') {
  app.use((req, res, next) => {
    if (req.secure || req.originalUrl === '/health') return next();
    if (req.method === 'GET' || req.method === 'HEAD') {
      return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
    }
    return res.status(403).json({ error: 'TLS is required for this endpoint' });
  });
}

// Mount webhooks BEFORE express.json() so they get raw Buffer bodies for HMAC verification
app.use(requestIdMiddleware);
app.use('/webhooks', webhookRouter);

app.use(express.json());
app.use(httpLogger);
app.use(globalRateLimiter);

// Routes. Sensitive surfaces carry their own stricter bucket on top of the
// global one (webhooks stay exempt — mounted before all limiters).
app.use('/auth', authRouter);
app.use('/admin', adminRateLimiter, adminRouter);
app.use('/matches', matchRateLimiter, matchRouter);
app.use('/callouts', calloutRateLimiter, calloutRouter);
app.use('/matchmaking', matchmakingRateLimiter, matchmakingRouter);
app.use('/wallet', walletRateLimiter, walletRouter);
app.use('/verification', verificationRateLimiter, verificationRouter);
app.use('/safer-play', saferPlayRateLimiter, saferPlayRouter);
app.use('/notifications', notificationRateLimiter, notificationRouter);

// Health Check Endpoint
app.get('/health', async (req, res) => {
  let dbStatus = 'ok';
  let redisStatus = 'ok';

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    logger.error({ err }, 'DB Healthcheck failed');
    dbStatus = 'failed';
  }

  if (redis) {
    try {
      await redis.ping();
    } catch (err) {
      logger.error({ err }, 'Redis Healthcheck failed');
      redisStatus = 'failed';
    }
  } else {
    redisStatus = 'not_configured';
  }

  const status = (dbStatus === 'ok' && redisStatus !== 'failed') ? 200 : 503;
  res.status(status).json({
    status: status === 200 ? 'ok' : 'error',
    db: dbStatus,
    redis: redisStatus,
    timestamp: new Date().toISOString()
  });
});

// Basic Error Handler (Never leaks stack traces to the client)
app.use(finalErrorHandler);

// Start Cron Jobs
if (process.env.NODE_ENV !== 'test') {
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
}

export default app;
