import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import logger from './logger.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString && process.env.NODE_ENV !== 'test') {
  throw new Error('FATAL: DATABASE_URL is missing.');
}

const isSimulationMode =
  process.env.NODE_ENV === 'development' && process.env.SIMULATION_ENABLED === 'true';

const pool = new pg.Pool({
  connectionString: connectionString || 'postgresql://localhost:5432/dummy',
  max: isSimulationMode ? 18 : 5,
  idleTimeoutMillis: 15_000,
  connectionTimeoutMillis: 30_000
});

// Neon Serverless Pooler closes idle TCP connections; without an error
// listener, pg.Pool emits an uncaught EventEmitter 'error' and crashes Node.
pool.on('error', (err) => {
  logger.error({ err: err.message, code: err.code }, 'Unexpected PostgreSQL pool idle client error');
});

const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({
  adapter,
  transactionOptions: {
    maxWait: isSimulationMode ? 25_000 : 10_000,
    timeout: isSimulationMode ? 45_000 : 15_000
  }
});

export default prisma;
