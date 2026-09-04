import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

let redisClient;
if (process.env.REDIS_URL) {
  redisClient = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy(times) {
      if (times > 3) return null;
      return Math.min(times * 200, 2000);
    }
  });
  redisClient.on('error', () => {}); // Handled gracefully
}

// Fallback to memory store if Redis is not connected/ready
const createStore = () => (redisClient && redisClient.status === 'ready')
  ? new RedisStore({
      sendCommand: (...args) => redisClient.call(...args),
    })
  : undefined;

export const globalRateLimiter = rateLimit({
  store: createStore(),
  windowMs: 60 * 1000, // 1 minute
  max: process.env.NODE_ENV === 'test' ? 1000 : 100, // Limit each IP to 100 requests per `window`
  message: 'Too many requests from this IP, please try again after a minute',
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

export const authRateLimiter = rateLimit({
  store: createStore(),
  windowMs: 60 * 1000, // 1 minute
  max: process.env.NODE_ENV === 'test' ? 1000 : 5, // Limit each IP to 5 auth requests per `window`
  message: 'Too many authentication attempts from this IP, please try again after a minute',
  standardHeaders: true,
  legacyHeaders: false,
});
