import Redis from 'ioredis';
import logger from './logger.js';

let redis = null;

if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL);
  redis.on('error', (err) => {
    logger.error({ err }, 'Redis connection error');
  });
} else if (process.env.NODE_ENV !== 'test') {
  throw new Error('FATAL: REDIS_URL environment variable is missing.');
}

export default redis;
