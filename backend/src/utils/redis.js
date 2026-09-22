import Redis from 'ioredis';
import logger from './logger.js';

let redis = null;

if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    family: 4,
    retryStrategy(times) {
      return Math.min(times * 200, 2000);
    }
  });
  redis.on('error', (err) => {
    logger.error({ err: err.message }, 'Redis connection error');
  });
  redis.on('ready', () => {
    logger.info('Redis connected');
  });
} else if (process.env.NODE_ENV !== 'test') {
  throw new Error('FATAL: REDIS_URL environment variable is missing.');
}

/** Jobs should no-op until the TCP connection is up. Test mocks omit `status`. */
export function isRedisReady(client = redis) {
  if (!client) return false;
  if (!client.status) return true;
  return client.status === 'ready';
}

export default redis;
