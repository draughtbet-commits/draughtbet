import { jest } from '@jest/globals';

const mockRedis = {
  scan: jest.fn(),
  hgetall: jest.fn()
};

const mockSettlement = {
  settleGameWithRetry: jest.fn().mockResolvedValue(undefined)
};

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
};

jest.unstable_mockModule('../../utils/redis.js', () => ({
  default: mockRedis,
  isRedisReady: jest.fn().mockReturnValue(true)
}));

jest.unstable_mockModule('../../sockets/settlement.js', () => mockSettlement);
jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: mockLogger
}));

describe('turnDeadlineSweep', () => {
  let processTurnDeadlineSweep;

  beforeAll(async () => {
    const mod = await import('../turnDeadlineSweep.js');
    processTurnDeadlineSweep = mod.processTurnDeadlineSweep;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('forfeits the player on the clock for every expired turn', async () => {
    const now = Date.now();
    mockRedis.scan.mockResolvedValueOnce([
      '0',
      ['match:a', 'match:b', 'match:c', 'match:done', 'match:no-tc']
    ]);
    mockRedis.hgetall.mockImplementation((key) => {
      if (key === 'match:a') return { player1: 'p1', player2: 'p2', status: 'in_progress', currentTurnUserId: 'p2', deadlineAt: String(now - 10) };
      if (key === 'match:b') return { player1: 'p3', player2: 'p4', status: 'in_progress', currentTurnUserId: 'p3', deadlineAt: String(now - 1) };
      if (key === 'match:c') return { player1: 'p5', player2: 'p6', status: 'in_progress', currentTurnUserId: 'p5', deadlineAt: String(now + 5000) };
      if (key === 'match:done') return { player1: 'p7', player2: 'p8', status: 'completed', currentTurnUserId: 'p7', deadlineAt: String(now - 10) };
      if (key === 'match:no-tc') return { player1: 'p9', player2: 'p10', status: 'in_progress', currentTurnUserId: 'p9' };
      return null;
    });

    const result = await processTurnDeadlineSweep({ now });

    expect(mockSettlement.settleGameWithRetry).toHaveBeenCalledTimes(2);
    expect(mockSettlement.settleGameWithRetry).toHaveBeenCalledWith('a', 'p1', 'p2', 'timeout_forfeit');
    expect(mockSettlement.settleGameWithRetry).toHaveBeenCalledWith('b', 'p4', 'p3', 'timeout_forfeit');
    expect(result.settled).toEqual(['a', 'b']);
  });

  it('paginates through multi-cursor SCAN round trips', async () => {
    const now = Date.now();
    mockRedis.scan
      .mockResolvedValueOnce(['5', ['match:a']])
      .mockResolvedValueOnce(['0', ['match:b']]);
    mockRedis.hgetall.mockResolvedValue({
      player1: 'x',
      player2: 'y',
      status: 'in_progress',
      currentTurnUserId: 'y',
      deadlineAt: String(now - 1)
    });

    await processTurnDeadlineSweep({ now });

    expect(mockRedis.scan).toHaveBeenCalledTimes(2);
    expect(mockRedis.scan).toHaveBeenLastCalledWith('5', 'MATCH', 'match:*', 'COUNT', 100);
    expect(mockSettlement.settleGameWithRetry).toHaveBeenCalledTimes(2);
  });

  it('continues past a settlement failure for one match (per-match try/catch)', async () => {
    const now = Date.now();
    mockRedis.scan.mockResolvedValueOnce(['0', ['match:a', 'match:b']]);
    mockRedis.hgetall.mockResolvedValue({
      player1: 'x',
      player2: 'y',
      status: 'in_progress',
      currentTurnUserId: 'y',
      deadlineAt: String(now - 1)
    });
    mockSettlement.settleGameWithRetry.mockRejectedValueOnce(new Error('boom'));

    const result = await processTurnDeadlineSweep({ now });

    expect(mockSettlement.settleGameWithRetry).toHaveBeenCalledTimes(2);
    expect(result.settled).toEqual(['b']);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ matchId: 'a' }),
      expect.stringContaining('settlement failed')
    );
  });

  it('skips matches whose opponent cannot be resolved', async () => {
    const now = Date.now();
    mockRedis.scan.mockResolvedValueOnce(['0', ['match:orphan']]);
    mockRedis.hgetall.mockResolvedValue({
      player1: 'p1',
      player2: null,
      status: 'in_progress',
      currentTurnUserId: 'p1',
      deadlineAt: String(now - 1)
    });

    const result = await processTurnDeadlineSweep({ now });

    expect(mockSettlement.settleGameWithRetry).not.toHaveBeenCalled();
    expect(result.settled).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ matchId: 'orphan' }),
      expect.stringContaining('cannot resolve opponent')
    );
  });
});