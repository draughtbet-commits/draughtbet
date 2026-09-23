import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import express from 'express';
import supertest from 'supertest';

let redisReady = false;
let failRedis = false;
const createdStores = [];
const createdInstances = [];

jest.unstable_mockModule('../../utils/redis.js', () => ({
  default: { call: jest.fn(async () => 'OK') },
  isRedisReady: () => redisReady,
}));

jest.unstable_mockModule('rate-limit-redis', () => ({
  RedisStore: class {
    constructor(opts) {
      this.opts = opts;
      createdStores.push(opts);
      createdInstances.push(this);
    }
    init = jest.fn(async () => {
      // Mirror rate-limit-redis' constructor wrapper: it unwraps the command
      // array and calls the store's sendCommand with positional args.
      await this.opts.sendCommand('SCRIPT', 'LOAD', '-- script --');
    });
    async increment() {
      if (failRedis) throw new Error('redis down');
      return { totalHits: 1, resetTime: new Date(Date.now() + 60_000) };
    }
    async decrement() {}
    async resetKey() {}
    async resetAll() {}
    shutdown() {}
  }
}));

afterAll(() => {
  jest.resetModules();
});

describe('rate limiter store selection', () => {
  let mod;

  beforeEach(async () => {
    jest.resetModules();
    redisReady = false;
    failRedis = false;
    createdStores.length = 0;
    createdInstances.length = 0;
    mod = await import('../rateLimit.js');
  });

  const hit = (app) => supertest(app).get('/');

  it('constructs a distinct-prefix shared Redis store per limiter once ready', async () => {
    redisReady = true;
    const app = express();
    app.use(mod.globalRateLimiter);
    app.use(mod.authRateLimiter);
    app.use(mod.checkRateLimiter);
    app.get('/', (req, res) => res.json({ ok: true }));

    const res = await hit(app);
    expect(res.status).toBe(200);

    expect(createdStores.map((s) => s.prefix).sort()).toEqual([
      'rl:http:auth:',
      'rl:http:check:',
      'rl:http:global:',
    ]);
  });

  it('no longer captures the store at module load: stays per-process memory when Redis never becomes ready', async () => {
    redisReady = false;
    expect(createdStores).toHaveLength(0);

    const app = express();
    app.use(mod.limiterFor({
      prefix: 'http:m:',
      windowMs: 60_000,
      max: 2,
      message: 'too many',
    }));
    app.get('/', (req, res) => res.json({ ok: true }));

    expect((await hit(app)).status).toBe(200);
    expect((await hit(app)).status).toBe(200);
    // Third request in the same window is throttled even with no Redis.
    expect((await hit(app)).status).toBe(429);
    expect(createdStores).toHaveLength(0);
  });

  it('fails open to memory when Redis errors mid-flight (availability preserved)', async () => {
    redisReady = true;
    failRedis = true;
    const app = express();
    app.use(mod.limiterFor({
      prefix: 'http:x:',
      windowMs: 60_000,
      max: 100,
      message: 'too many',
    }));
    app.get('/', (req, res) => res.json({ ok: true }));

    // The Redis increment throws, the store falls back to per-process memory,
    // and the request still succeeds within the local budget.
    expect((await hit(app)).status).toBe(200);
  });

  it('initializes the RedisStore with the limiter options before first use', async () => {
    redisReady = true;
    const app = express();
    app.use(mod.limiterFor({
      prefix: 'http:init:',
      windowMs: 12345,
      max: 2,
      message: 'too many',
    }));
    app.get('/', (req, res) => res.json({ ok: true }));

    expect((await hit(app)).status).toBe(200);
    expect(createdInstances).toHaveLength(1);
    const store = createdInstances[0];
    expect(store.opts.prefix).toBe('rl:http:init:');
    // Regression: the RedisStore was never init'd, so windowMs stayed undefined
    // and every request threw and silently degraded to per-process memory.
    expect(store.init).toHaveBeenCalledTimes(1);
    expect(store.init.mock.calls[0][0]).toMatchObject({ windowMs: 12345, max: 2 });
  });

  it('reuses the initialized RedisStore across requests once ready', async () => {
    redisReady = true;
    const app = express();
    app.use(mod.limiterFor({
      prefix: 'http:reuse:',
      windowMs: 60_000,
      max: 1000,
      message: 'too many',
    }));
    app.get('/', (req, res) => res.json({ ok: true }));

    expect((await hit(app)).status).toBe(200);
    expect((await hit(app)).status).toBe(200);
    expect(createdStores).toHaveLength(1);
  });

  it('adapts the RedisStore sendCommand contract to the redis client', async () => {
    redisReady = true;
    const app = express();
    app.use(mod.limiterFor({
      prefix: 'http:svc:',
      windowMs: 60_000,
      max: 100,
      message: 'too many',
    }));
    app.get('/', (req, res) => res.json({ ok: true }));

    expect((await hit(app)).status).toBe(200);
    const { default: mockRedis } = await import('../../utils/redis.js');
    // init() loads the Lua scripts through sendCommand, which rate-limit-redis
    // unwraps into positional command args.
    expect(mockRedis.call).toHaveBeenCalled();
    const first = mockRedis.call.mock.calls[0];
    expect(first[0]).toBe('SCRIPT');
    expect(first[1]).toBe('LOAD');
  });

  it('exposes distinct per-route limiters with their own stored budgets', async () => {
    redisReady = true;
    const app = express();
    app.use(mod.adminRateLimiter);
    app.use(mod.adminMfaRateLimiter);
    app.use(mod.withdrawalRateLimiter);
    app.use(mod.depositRateLimiter);
    app.use(mod.verificationRateLimiter);
    app.use(mod.saferPlayRateLimiter);
    app.use(mod.walletRateLimiter);
    app.use(mod.matchRateLimiter);
    app.use(mod.calloutRateLimiter);
    app.use(mod.matchmakingRateLimiter);
    app.use(mod.notificationRateLimiter);
    app.get('/', (req, res) => res.json({ ok: true }));

    expect((await hit(app)).status).toBe(200);

    const prefixes = createdStores.map((s) => s.prefix).sort();
    for (const prefix of [
      'rl:http:admin:',
      'rl:http:admin:mfa:',
      'rl:http:withdrawal:',
      'rl:http:deposit:',
      'rl:http:verification:',
      'rl:http:saferplay:',
      'rl:http:wallet:',
      'rl:http:match:',
      'rl:http:callout:',
      'rl:http:matchmaking:',
      'rl:http:notification:',
    ]) {
      expect(prefixes).toContain(prefix);
    }
    // exactly the eleven route buckets, each with its own budget
    expect(new Set(prefixes).size).toBe(11);
  });
});