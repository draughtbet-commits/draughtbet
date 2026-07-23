import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import logger from './utils/logger.js';
import prisma from './utils/db.js';
import Redis from 'ioredis';
import { globalRateLimiter } from './middleware/rateLimit.js';
import { authRouter } from './modules/auth/controller.js';
import { matchRouter } from './modules/match/controller.js';
import { startDisconnectSweep } from './jobs/disconnectSweep.js';
import { startReconciliationSweep } from './jobs/reconciliationSweep.js';

const app = express();
// Prisma initialized in utils/db.js

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
  ? { origin: corsOrigin }
  : (process.env.NODE_ENV === 'test' ? { origin: true } : { origin: 'http://localhost:3000' });
app.use(cors(corsOptions));
app.use(express.json());
app.use(pinoHttp({ logger }));
app.use(globalRateLimiter);

// Routes
app.use('/auth', authRouter);
app.use('/matches', matchRouter);

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
app.use((err, req, res, next) => {
  logger.error({ err }, 'Unhandled exception');
  res.status(500).json({ error: 'Internal Server Error' });
});

// Start Cron Jobs
if (process.env.NODE_ENV !== 'test') {
  startDisconnectSweep();
  startReconciliationSweep();
}

export default app;
