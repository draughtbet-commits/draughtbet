import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';

let redisReady = false;
let evalCommand;

jest.unstable_mockModule('../../utils/redis.js', () => ({
  default: {
    eval: (...args) => evalCommand(...args),
  },
  isRedisReady: () => redisReady,
}));

afterAll(() => {
  jest.resetModules();
});

describe('socket event budgets', () => {
  let consumeBudget;
  let socketEventBudget;

  beforeEach(async () => {
    jest.resetModules();
    redisReady = false;
    evalCommand = jest.fn(async () => [1, 60000]);
    const mod = await import('../budget.js');
    consumeBudget = mod.consumeBudget;
    socketEventBudget = mod.socketEventBudget;
  });

  it('budget defaults bound each event type', () => {
    expect(socketEventBudget('move_attempt').max).toBe(60);
    expect(socketEventBudget('resign').max).toBe(10);
    expect(socketEventBudget('join_match').max).toBe(30);
  });

  it('allows events within the budget and throttles a burst (memory fallback)', async () => {
    const results = [];
    for (let i = 0; i < 12; i++) {
      results.push(await consumeBudget({ userId: 'u1', eventName: 'resign' }));
    }
    expect(results.filter((r) => r.allowed).length).toBe(10);
    expect(results[10].allowed).toBe(false);
    expect(results[10].retryAfterMs).toBeGreaterThan(0);
    expect(results[11].allowed).toBe(false);
  });

  it('treats different events as independent budgets', async () => {
    for (let i = 0; i < 10; i++) {
      await consumeBudget({ userId: 'u1', eventName: 'resign' });
    }
    const move = await consumeBudget({ userId: 'u1', eventName: 'move_attempt' });
    expect(move.allowed).toBe(true);
    const nextResign = await consumeBudget({ userId: 'u1', eventName: 'resign' });
    expect(nextResign.allowed).toBe(false);
  });

  it('treats different users as independent budgets', async () => {
    for (let i = 0; i < 10; i++) {
      await consumeBudget({ userId: 'u2', eventName: 'resign' });
    }
    const other = await consumeBudget({ userId: 'u3', eventName: 'resign' });
    expect(other.allowed).toBe(true);
    const exhausted = await consumeBudget({ userId: 'u2', eventName: 'resign' });
    expect(exhausted.allowed).toBe(false);
  });

  it('uses the Redis budget when Redis is ready', async () => {
    redisReady = true;
    const result = await consumeBudget({ userId: 'u1', eventName: 'move_attempt' });
    expect(evalCommand).toHaveBeenCalled();
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(59);
  });

  it('falls back to memory when Redis errors mid-flight (fail-open)', async () => {
    redisReady = true;
    evalCommand = jest.fn(async () => { throw new Error('redis down'); });
    const result = await consumeBudget({ userId: 'u1', eventName: 'move_attempt' });
    expect(result.allowed).toBe(true);
  });

  it('honours an env override for tests/tuning', async () => {
    process.env.SOCKET_BUDGET_MOVE_ATTEMPT_MAX = '3';
    try {
      const mod = await import('../budget.js');
      expect(mod.socketEventBudget('move_attempt').max).toBe(3);
      let allAllowed = true;
      for (let i = 0; i < 3; i++) {
        const r = await mod.consumeBudget({ userId: 'u1', eventName: 'move_attempt' });
        allAllowed = allAllowed && r.allowed;
      }
      expect(allAllowed).toBe(true);
      const over = await mod.consumeBudget({ userId: 'u1', eventName: 'move_attempt' });
      expect(over.allowed).toBe(false);
    } finally {
      delete process.env.SOCKET_BUDGET_MOVE_ATTEMPT_MAX;
    }
  });
});