import redis, { isRedisReady } from '../utils/redis.js';
import logger from '../utils/logger.js';

// Distinct key namespace so socket budgets never collide with HTTP limiter keys.
const BUDGET_KEY_PREFIX = 'sockrl:';

// Fixed-window budget: INCR and auto-expire on first hit. EXPIRE resets the
// window only when the counter is brand new, so the budget always spans the
// configured window without sliding it on every event.
const consumeScript = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
return { current, redis.call("PTTL", KEYS[1]) }
`;

// Per-user, per-event budgets. The move budget is deliberately generous for
// legitimate play through the whole game while still bounding a flood; the
// low-volume events are tighter.
const DEFAULT_BUDGETS = {
  move_attempt: { max: 60, windowMs: 60 * 1000 },
  resign: { max: 10, windowMs: 60 * 1000 },
  join_match: { max: 30, windowMs: 60 * 1000 },
};

const envMax = (eventName) => {
  const value = process.env[`SOCKET_BUDGET_${eventName.toUpperCase()}_MAX`];
  if (value && Number.isInteger(Number(value)) && Number(value) > 0) return Number(value);
  return null;
};

export const socketEventBudget = (eventName) => {
  const base = DEFAULT_BUDGETS[eventName] || DEFAULT_BUDGETS.move_attempt;
  return { max: envMax(eventName) ?? base.max, windowMs: base.windowMs };
};

const budgetKey = (userId, eventName) => `${BUDGET_KEY_PREFIX}${userId}:${eventName}`;

// Per-process fallback for a Redis outage (fail-open, still limited locally).
const memoryCounters = new Map(); // key -> { count, resetAt }

const consumeMemory = (key, max, windowMs) => {
  const now = Date.now();
  const entry = memoryCounters.get(key);
  if (!entry || entry.resetAt <= now) {
    memoryCounters.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: max - 1, retryAfterMs: 0 };
  }
  entry.count += 1;
  if (entry.count > max) {
    return { allowed: false, remaining: 0, retryAfterMs: entry.resetAt - now };
  }
  return { allowed: true, remaining: max - entry.count, retryAfterMs: 0 };
};

// Bounded memory footprint: sweep expired budget rows that lazy reads would
// leave behind for departed users.
const sweepInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memoryCounters.entries()) {
    if (entry.resetAt <= now) memoryCounters.delete(key);
  }
}, 60 * 1000);
sweepInterval.unref?.();

/**
 * Consumes one budget token for a user/event pair.
 * @returns {Promise<{allowed: boolean, remaining: number, retryAfterMs: number}>}
 */
export const consumeBudget = async ({ userId, eventName }) => {
  const { max, windowMs } = socketEventBudget(eventName);
  const key = budgetKey(userId, eventName);

  if (isRedisReady(redis)) {
    try {
      const [count, ttl] = await redis.eval(consumeScript, 1, key, String(windowMs));
      if (count > max) {
        return { allowed: false, remaining: 0, retryAfterMs: Math.max(ttl, 0) };
      }
      return { allowed: true, remaining: max - count, retryAfterMs: 0 };
    } catch (err) {
      logger.warn({ err, eventName, userId },
        'Redis socket budget unavailable; using per-process memory');
    }
  }
  return consumeMemory(key, max, windowMs);
};

// Connection quota: how many simultaneous sockets one account may hold.
export const MAX_SOCKETS_PER_USER = envMax('SOCKETS') ?? 5;
