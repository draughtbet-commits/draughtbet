import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import express from 'express';
import supertest from 'supertest';

let redisReady = false;
let failRedis = false;
const createdStores = [];

jest.unstable_mockModule('../../utils/redis.js', () => ({
  default: { call: jest.fn(async () => 'OK') },
  isRedisReady: () => redisReady,
}));

jest.unstable_mockModule('rate-limit-redis', () => ({
  RedisStore: class {
    constructor(opts) {
      this.opts = opts;
      createdStores.push(opts);
    }
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
});