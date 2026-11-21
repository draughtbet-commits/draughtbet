import { rateLimit, MemoryStore, ipKeyGenerator } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import logger from '../utils/logger.js';
import redis, { isRedisReady } from '../utils/redis.js';

// Every limiter keys Redis entries under its own prefix so a user's auth
// attempts never collide with their general traffic (or another limiter's).
const REDIS_KEY_PREFIX = 'rl:';

const LIMITER_DEFAULTS = {
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  // Limiters are stacked (route bucket over the global one); singleCount would
  // abort the stacked increment and defeat the route-specific budgets.
  validate: { singleCount: false, xForwardedForHeader: false, validationsConfig: false, keyGeneratorIpFallback: false },
  // When local dev simulation is active, isolate rate-limit buckets per simulated
  // identity (`x-sim-user`) so 20 independent users do not share one localhost IP bucket.
  keyGenerator: (req) => {
    const baseIp = ipKeyGenerator(req.ip || '127.0.0.1');
    if (process.env.NODE_ENV === 'development' && process.env.SIMULATION_ENABLED === 'true') {
      const simTag = req.get('x-sim-user');
      if (typeof simTag === 'string' && /^[A-Za-z0-9_.+-]{4,80}$/.test(simTag)) {
        return `${baseIp}:sim:${simTag}`;
      }
    }
    return baseIp;
  }
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
  let redisStoreInit = null;
  let options = null;

  const createRedisStore = async () => {
    const candidate = new RedisStore({
      // rate-limit-redis unwraps its command array and calls our function with
      // the command name + args as positional arguments.
      sendCommand: (...args) => redis.call(...args),
      prefix: `${REDIS_KEY_PREFIX}${prefix}`,
    });
    // The RedisStore must be initialized (windowMs + Lua scripts) before its
    // first use; express-rate-limit only calls init on this wrapper, so we
    // initialize here once the connection is ready.
    await candidate.init(options);
    redisStore = candidate;
    logger.info({ prefix: `${REDIS_KEY_PREFIX}${prefix}` }, 'Rate limiter using shared Redis store');
    return candidate;
  };

  const getRedisStore = () => {
    if (redisStore) return Promise.resolve(redisStore);
    if (!isRedisReady(redis) || !options) return Promise.resolve(null);
    redisStoreInit ??= createRedisStore();
    return redisStoreInit.catch((err) => {
      redisStoreInit = null;
      throw err;
    });
  };

  const store = {
    localKeys: false,
    init(limiterOptions) {
      options = limiterOptions;
      memory.init(limiterOptions);
    },
    async increment(key) {
      let remote = null;
      try {
        remote = await getRedisStore();
      } catch { /* RedisStore init failed; degrade to memory */ }
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
      let remote = null;
      try {
        remote = await getRedisStore();
      } catch { /* RedisStore init failed; degrade to memory */ }
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
      let remote = null;
      try {
        remote = await getRedisStore();
      } catch { /* RedisStore init failed; degrade to memory */ }
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
      let remote = null;
      try {
        remote = await getRedisStore();
      } catch { /* RedisStore init failed; degrade to memory */ }
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

export const limiterFor = ({ windowMs, max, message, prefix, handler }) => rateLimit({
  store: createResilientStore(prefix),
  windowMs,
  max:
    // Load runs lift every bucket so a single source IP can measure the app
    // ceiling. Test-only: production silently ignores the flag.
    process.env.NODE_ENV === 'test' && process.env.RATE_LIMIT_DISABLED === 'true' ? 1_000_000 : max,
  message,
  ...(handler ? { handler } : {}),
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

// Route-specific buckets. These sit on top of the global limiter so an
// attack on a sensitive endpoint exhausts its own budget instead of starving
// the rest of the app. Webhooks are mounted BEFORE globalRateLimiter so player
// traffic cannot starve provider callbacks, and carry their own dedicated
// webhookRateLimiter + invalid-signature abuse limiter.
export const adminRateLimiter = limiterFor({
  prefix: 'http:admin:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 1000 : 120,
  message: 'Too many admin requests from this IP, please try again after a minute',
});

// TOTP provisioning / verification / recovery is the one path an attacker can
// hammer to guess codes, so it gets its own strict IP budget on top of the
// per-admin Redis lock inside AdminMfaService.
export const adminMfaRateLimiter = limiterFor({
  prefix: 'http:admin:mfa:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 1000 : 6,
  message: 'Too many admin MFA attempts, please try again later',
});

const parsePositiveInt = (raw, fallback) => {
  const n = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// Dedicated webhook rate limiter mounted on /webhooks before globalRateLimiter.
// Allows high burst capacity (120/min default, configurable via WEBHOOK_RATE_LIMIT_MAX)
// so legitimate Paystack/Flutterwave retries and concurrent payment spikes are
// never broken, while capping unauthenticated flood traffic and emitting
// structured logs + Retry-After headers.
export const webhookRateLimiter = limiterFor({
  prefix: 'http:webhook:',
  windowMs: 60 * 1000,
  max: (req) => {
    const configured = parsePositiveInt(process.env.WEBHOOK_RATE_LIMIT_MAX, null);
    if (configured !== null) return configured;
    return process.env.NODE_ENV === 'test' ? 1000 : 120;
  },
  message: 'Too many webhook requests, please retry shortly',
  handler: (req, res, _next, options) => {
    logger.warn(
      {
        event: 'webhook_rate_limited',
        requestId: req.id,
        ip: req.ip,
        path: req.originalUrl || req.path
      },
      'Webhook request rate limited'
    );
    res.set('Retry-After', String(Math.ceil((options.windowMs || 60_000) / 1000)));
    return res.status(options.statusCode || 429).json({
      error: typeof options.message === 'string' ? options.message : 'Too many webhook requests'
    });
  }
});

// Separate invalid-signature abuse tracker for webhooks: incremented ONLY when
// HMAC/secret verification fails. Legitimate signed provider retries NEVER
// touch this bucket, whereas an unauthenticated attacker spraying forged
// webhooks gets throttled rapidly with 429.
const WEBHOOK_INVALID_SIG_WINDOW_MS = 60 * 1000;
const webhookBadAuthStore = createResilientStore('http:webhook:bad_auth:');
webhookBadAuthStore.init({ windowMs: WEBHOOK_INVALID_SIG_WINDOW_MS });
const webhookBadAuthCounts = new Map(); // tracks local memory mirror for read-without-increment

const getWebhookInvalidSigLimit = () => {
  const configured = parsePositiveInt(process.env.WEBHOOK_INVALID_SIG_MAX, null);
  if (configured !== null) return configured;
  return process.env.NODE_ENV === 'test' ? 1000 : 20;
};

const webhookAbuseKey = (req, provider) => {
  const baseIp = ipKeyGenerator(req.ip || '127.0.0.1');
  return `${provider}:${baseIp}`;
};

export const isWebhookAuthAbuseBlocked = async (req, provider) => {
  const limit = getWebhookInvalidSigLimit();
  const key = webhookAbuseKey(req, provider);
  if (isRedisReady(redis)) {
    try {
      const val = await redis.get(`${REDIS_KEY_PREFIX}http:webhook:bad_auth:${key}`);
      if (Number(val || 0) >= limit) return true;
    } catch {
      // fall through to memory check
    }
  }
  const entry = webhookBadAuthCounts.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    webhookBadAuthCounts.delete(key);
    return false;
  }
  return entry.hits >= limit;
};

export const recordWebhookInvalidSignature = async (req, provider) => {
  const limit = getWebhookInvalidSigLimit();
  const key = webhookAbuseKey(req, provider);
  const now = Date.now();
  let totalHits = 1;
  try {
    const res = await webhookBadAuthStore.increment(key);
    totalHits = Number(res?.totalHits ?? 1);
  } catch {
    totalHits = 1;
  }
  const existing = webhookBadAuthCounts.get(key);
  if (!existing || existing.expiresAt <= now) {
    webhookBadAuthCounts.set(key, { hits: totalHits, expiresAt: now + WEBHOOK_INVALID_SIG_WINDOW_MS });
  } else {
    existing.hits = Math.max(existing.hits + 1, totalHits);
    totalHits = existing.hits;
  }
  const blocked = totalHits >= limit;
  if (blocked) {
    logger.warn(
      {
        event: 'webhook_invalid_signature_throttled',
        provider,
        requestId: req.id,
        ip: req.ip,
        hits: totalHits,
        limit
      },
      'Webhook source throttled after repeated invalid signatures'
    );
  }
  return { totalHits, limit, blocked };
};

export const resetWebhookAuthAbuse = async () => {
  webhookBadAuthCounts.clear();
  await webhookBadAuthStore.resetAll();
};

export const withdrawalRateLimiter = limiterFor({
  prefix: 'http:withdrawal:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 1000 : 12,
  message: 'Too many withdrawal requests, please try again after a minute',
});

export const depositRateLimiter = limiterFor({
  prefix: 'http:deposit:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 1000 : 12,
  message: 'Too many deposit requests, please try again after a minute',
});

export const verificationRateLimiter = limiterFor({
  prefix: 'http:verification:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 1000 : 6,
  message: 'Too many verification requests, please try again after a minute',
});

export const saferPlayRateLimiter = limiterFor({
  prefix: 'http:saferplay:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 1000 : 15,
  message: 'Too many requests, please try again after a minute',
});

export const walletRateLimiter = limiterFor({
  prefix: 'http:wallet:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 1000 : 120,
  message: 'Too many wallet requests, please try again after a minute',
});

export const matchRateLimiter = limiterFor({
  prefix: 'http:match:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 1000 : 60,
  message: 'Too many match requests, please try again after a minute',
});

export const calloutRateLimiter = limiterFor({
  prefix: 'http:callout:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 1000 : 30,
  message: 'Too many callout requests, please try again after a minute',
});

export const matchmakingRateLimiter = limiterFor({
  prefix: 'http:matchmaking:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 1000 : 30,
  message: 'Too many matchmaking requests, please try again after a minute',
});

export const notificationRateLimiter = limiterFor({
  prefix: 'http:notification:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'test' ? 1000 : 60,
  message: 'Too many notification requests, please try again after a minute',
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
