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
  notificationRateLimiter,
  supportRateLimiter
} from './middleware/rateLimit.js';
import { requestIdMiddleware, finalErrorHandler } from './middleware/requestId.js';
import { authRouter } from './modules/auth/controller.js';
import { meRouter } from './modules/me/controller.js';
import { adminRouter } from './modules/admin/controller.js';
import { matchRouter } from './modules/match/controller.js';
import { disputeUserRouter } from './modules/disputes/controller.js';
import { calloutRouter } from './modules/callout/controller.js';
import { matchmakingRouter } from './modules/matchmaking/controller.js';
import { walletRouter, depositsRouter } from './modules/wallet/controller.js';
import { withdrawalUserRouter } from './modules/withdrawal/controller.js';
import { webhookRouter } from './modules/payment/webhookController.js';
import { notificationRouter } from './modules/notification/controller.js';
import { verificationRouter } from './modules/verification/controller.js';
import { saferPlayRouter } from './modules/saferPlay/controller.js';
import { supportRouter } from './modules/support/controller.js';

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
    if (req.secure || req.originalUrl === '/health' || req.originalUrl === '/ready') return next();
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

// Versioned API routes. Sensitive surfaces carry their own stricter bucket on
// top of the global one (webhooks stay exempt — mounted before all limiters).
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/me', meRouter);
app.use('/api/v1/admin', adminRateLimiter, adminRouter);
app.use('/api/v1/matches', matchRateLimiter, matchRouter);
app.use('/api/v1/matches', matchRateLimiter, disputeUserRouter);
app.use('/api/v1/callouts', calloutRateLimiter, calloutRouter);
app.use('/api/v1/matchmaking', matchmakingRateLimiter, matchmakingRouter);
app.use('/api/v1/wallet', walletRateLimiter, walletRouter);
app.use('/api/v1/deposits', walletRateLimiter, depositsRouter);
app.use('/api/v1/withdrawals', walletRateLimiter, withdrawalUserRouter);
app.use('/api/v1/verification', verificationRateLimiter, verificationRouter);
app.use('/api/v1/safer-play', saferPlayRateLimiter, saferPlayRouter);
app.use('/api/v1/support', supportRateLimiter, supportRouter);
app.use('/api/v1/notifications', notificationRateLimiter, notificationRouter);

// Liveness probe: the process is up. No dependencies are checked here — that
// is /ready's job (readiness). Kept cheap and always 200 so load balancers and
// orchestrators can tell "process alive" from "dependencies reachable".
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Readiness probe: DB + Redis must be reachable before the container takes
// traffic. Reuses the same SELECT 1 / PING checks the old /health performed.
app.get('/ready', async (_req, res) => {
  let dbStatus = 'ok';
  let redisStatus = 'ok';

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    logger.error({ err }, 'DB readiness check failed');
    dbStatus = 'failed';
  }

  if (redis) {
    try {
      await redis.ping();
    } catch (err) {
      logger.error({ err }, 'Redis readiness check failed');
      redisStatus = 'failed';
    }
  } else {
    redisStatus = 'not_configured';
  }

  const status = (dbStatus === 'ok' && redisStatus !== 'failed') ? 200 : 503;
  res.status(status).json({
    status: status === 200 ? 'ready' : 'not_ready',
    db: dbStatus,
    redis: redisStatus,
    timestamp: new Date().toISOString()
  });
});

// Basic Error Handler (Never leaks stack traces to the client)
app.use(finalErrorHandler);

export default app;
