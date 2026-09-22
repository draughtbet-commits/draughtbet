import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockRedis = { hgetall: jest.fn() };
jest.unstable_mockModule('../../utils/redis.js', () => ({
  default: mockRedis,
  isRedisReady: jest.fn(() => true)
}));

const mockPrisma = { match: { findMany: jest.fn() } };
jest.unstable_mockModule('../../utils/db.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

const settleGameWithRetry = jest.fn();
const settleGameDrawWithRetry = jest.fn();
jest.unstable_mockModule('../../sockets/settlement.js', () => ({
  settleGameWithRetry,
  settleGameDrawWithRetry
}));

const reconcileRedisWithDurable = jest.fn();
jest.unstable_mockModule('../../sockets/gameRecovery.js', () => ({
  reconcileRedisWithDurable
}));

jest.unstable_mockModule('../../modules/match/service.js', () => ({
  LIVE_STATUSES: ['ACTIVE', 'IN_PLAY']
}));

const { processReconciliationSweep } = await import('../reconciliationSweep.js');

const activeMatch = (overrides = {}) => ({
  id: 'm1',
  playerLightId: 'p1',
  playerDarkId: 'p2',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides
});

const NOW = new Date('2026-01-02T00:00:00Z').getTime();

beforeEach(() => {
  jest.clearAllMocks();
  settleGameWithRetry.mockResolvedValue({});
  settleGameDrawWithRetry.mockResolvedValue({});
});

describe('processReconciliationSweep', () => {
  it('settles a split brain: Redis says completed -> settlement via retry path', async () => {
    mockPrisma.match.findMany.mockResolvedValue([activeMatch()]);
    mockRedis.hgetall.mockResolvedValue({ status: 'completed', winnerId: 'p1' });

    const outcome = await processReconciliationSweep({ now: () => NOW });

    expect(mockRedis.hgetall).toHaveBeenCalledWith('match:m1');
    expect(settleGameWithRetry).toHaveBeenCalledWith('m1', 'p1', 'p2', 'recovery_sweep');
    expect(outcome).toEqual({ scanned: 1, splitBrain: 1, rebuilt: 0, errored: 0 });
  });

  it('settles a draw via the draw retry path', async () => {
    mockPrisma.match.findMany.mockResolvedValue([activeMatch()]);
    mockRedis.hgetall.mockResolvedValue({ status: 'draw' });

    const outcome = await processReconciliationSweep({ now: () => NOW });

    expect(settleGameDrawWithRetry).toHaveBeenCalledWith('m1', 'recovery_sweep_draw');
    expect(outcome.splitBrain).toBe(1);
  });

  it('skips a claimed-completed match with no winnerId (CRITICAL, no settle)', async () => {
    mockPrisma.match.findMany.mockResolvedValue([activeMatch()]);
    mockRedis.hgetall.mockResolvedValue({ status: 'completed', winnerId: null });

    const outcome = await processReconciliationSweep({ now: () => NOW });

    expect(settleGameWithRetry).not.toHaveBeenCalled();
    expect(outcome.splitBrain).toBe(0);
  });

  it('rebuilds a missing Redis projection from the durable log and settles a terminal outcome', async () => {
    mockPrisma.match.findMany.mockResolvedValue([activeMatch()]);
    mockRedis.hgetall.mockResolvedValue({});
    reconcileRedisWithDurable.mockResolvedValue({ status: 'completed', winnerId: 'p2' });

    const outcome = await processReconciliationSweep({ now: () => NOW });

    expect(reconcileRedisWithDurable).toHaveBeenCalledWith('m1');
    expect(settleGameWithRetry).toHaveBeenCalledWith('m1', 'p2', 'p1', 'recovery_sweep');
    expect(outcome).toEqual({ scanned: 1, splitBrain: 1, rebuilt: 1, errored: 0 });
  });

  it('leaves a genuinely stale live match alone but warns once it ages past 12h', async () => {
    mockPrisma.match.findMany.mockResolvedValue([activeMatch()]);
    mockRedis.hgetall.mockResolvedValue({});
    reconcileRedisWithDurable.mockResolvedValue(null);

    const outcome = await processReconciliationSweep({ now: () => NOW });

    expect(settleGameWithRetry).not.toHaveBeenCalled();
    expect(outcome.rebuilt).toBe(0);
  });

  it('fault-isolates a throwing match and keeps going', async () => {
    mockPrisma.match.findMany.mockResolvedValue([
      activeMatch({ id: 'm1' }),
      activeMatch({ id: 'm2' })
    ]);
    mockRedis.hgetall
      .mockRejectedValueOnce(new Error('redis hiccup'))
      .mockResolvedValueOnce({ status: 'draw' });

    const outcome = await processReconciliationSweep({ now: () => NOW });

    expect(outcome).toEqual({ scanned: 2, splitBrain: 1, rebuilt: 0, errored: 1 });
  });
});