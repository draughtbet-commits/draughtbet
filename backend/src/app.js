import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import logger from './utils/logger.js';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import Redis from 'ioredis';
import { globalRateLimiter } from './middleware/rateLimit.js';
import { authRouter } from './modules/auth/controller.js';

const app = express();
const connectionString = process.env.DATABASE_URL || 'postgresql://localhost:5432/dummy';
const pool = new pg.Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Setup Redis correctly
let redis;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL);
}

// Global middlewares
app.use(helmet());
app.use(cors({ origin: process.env.ADMIN_CORS_ORIGIN || '*' })); // Restrict CORS in production
app.use(express.json());
app.use(pinoHttp({ logger }));
app.use(globalRateLimiter);

// Routes
app.use('/auth', authRouter);

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

export default app;
