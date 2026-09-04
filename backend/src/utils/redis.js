import Redis from 'ioredis';
import logger from './logger.js';

let redis = null;

if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy(times) {
      if (times > 3) return null; // Stop retrying if Redis is unavailable
      return Math.min(times * 200, 2000);
    }
  });
  redis.on('error', (err) => {
    logger.error({ err: err.message }, 'Redis connection error');
  });
} else if (process.env.NODE_ENV !== 'test') {
  throw new Error('FATAL: REDIS_URL environment variable is missing.');
}

export default redis;
