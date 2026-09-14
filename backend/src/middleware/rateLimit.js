import { rateLimit, MemoryStore } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import logger from '../utils/logger.js';
import redis, { isRedisReady } from '../utils/redis.js';

// Every limiter keys Redis entries under its own prefix so a user's auth
// attempts never collide with their general traffic (or another limiter's).
const REDIS_KEY_PREFIX = 'rl:';

const LIMITER_DEFAULTS = {
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
};

/**
 * A rate-limit store that is shared across instances whenever Redis is
 * reachable, and degrades explicitly to a per-process memory store during a
 * Redis outage.
 *
 * The Redis store is only constructed once the connection is *ready* (never at
 * module load, when the connection is still pending — the old bug silently
 * selected memory forever). It hot-swaps to Redis on readiness and falls back
 * to memory per request if Redis drops or errors, so a limiter never fails a
 * request closed because of a memory/Redis decision made at boot.
 */
export const createResilientStore = (prefix) => {
  const memory = new MemoryStore();
  let redisStore = null;

  const getRedisStore = () => {
    if (redisStore) return redisStore;
    if (isRedisReady(redis)) {
      redisStore = new RedisStore({
        sendCommand: (...args) => redis.call(...args),
        prefix: `${REDIS_KEY_PREFIX}${prefix}`,
      });
      logger.info({ prefix: `${REDIS_KEY_PREFIX}${prefix}` }, 'Rate limiter using shared Redis store');
    }
    return redisStore;
  };

  const store = {
    localKeys: false,
    init(options) {
      store.options = options;
      memory.init(options);
    },
    async increment(key) {
      const remote = getRedisStore();
      if (remote) {
        try {
          return await remote.increment(key);
        } catch (err) {
          // Explicit outage behavior: fail open to per-process memory. The
          // request is still limited locally; distributed guarantees degrade
          // but availability is preserved.
          logger.warn({ err, prefix: `${REDIS_KEY_PREFIX}${prefix}` },
            'Redis rate-limit store unavailable; falling back to per-process memory');
        }
      }
      return memory.increment(key);
    },
    async decrement(key) {
      const remote = getRedisStore();
      if (remote) {
        try {
          return await remote.decrement(key);
        } catch (err) {
          logger.warn({ err }, 'Redis rate-limit decrement failed; using per-process memory');
        }
      }
      return memory.decrement(key);
    },
    async resetKey(key) {
      const remote = getRedisStore();
      if (remote) {
        try {
          return await remote.resetKey(key);
        } catch (err) {
          logger.warn({ err }, 'Redis rate-limit reset failed; using per-process memory');
        }
      }
      return memory.resetKey(key);
    },
    async resetAll() {
      const remote = getRedisStore();
      if (remote) {
        try {
          return await remote.resetAll();
        } catch (err) {
          logger.warn({ err }, 'Redis rate-limit reset-all failed; using per-process memory');
        }
      }
      return memory.resetAll();
    },
    shutdown() {
      memory.shutdown();
      redisStore?.shutdown?.();
    },
  };
  return store;
};

export const limiterFor = ({ windowMs, max, message, prefix }) => rateLimit({
  store: createResilientStore(prefix),
  windowMs,
  max,
  message,
  ...LIMITER_DEFAULTS,
});

// Global bucket applied to every HTTP request (except webhooks, which are
// mounted before it). Comment-driven intent: shared across instances.
export const globalRateLimiter = limiterFor({
  prefix: 'http:global:',
  windowMs: 60 * 1000, // 1 minute
  max: process.env.NODE_ENV === 'test' ? 1000 : 100, // 100 requests per IP per window
  message: 'Too many requests from this IP, please try again after a minute',
});

export const authRateLimiter = limiterFor({
  prefix: 'http:auth:',
  windowMs: 60 * 1000, // 1 minute
  max: process.env.NODE_ENV === 'test' ? 1000 : 5, // 5 auth attempts per IP per window
  message: 'Too many authentication attempts from this IP, please try again after a minute',
});

// Pre-auth form helpers (realtime uniqueness checks + geo validation) are
// callable more often than login/register, but still rate limited to prevent
// abuse of the availability oracle.
export const checkRateLimiter = limiterFor({
  prefix: 'http:check:',
  windowMs: 60 * 1000, // 1 minute
  max: process.env.NODE_ENV === 'test' ? 1000 : 60, // 60 pre-auth checks per IP per window
  message: 'Too many requests from this IP, please try again after a minute',
});

/**
 * Bounded wait for Redis readiness so the shared limiter is in service for the
 * first request in production. Resolves false after `timeoutMs` with nothing
 * thrown — the resilient store degrades to per-process memory (logged) until
 * Redis is reachable.
 */
export const waitForRateLimitRedis = (timeoutMs = 3000) => new Promise((resolve) => {
  if (isRedisReady(redis)) return resolve(true);
  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (isRedisReady(redis)) {
      clearInterval(timer);
      return resolve(true);
    }
    if (Date.now() - startedAt >= timeoutMs) {
      clearInterval(timer);
      logger.warn({ timeoutMs },
        'Redis not ready within budget; rate limiter starting on per-process memory');
      return resolve(false);
    }
  }, 100);
});
