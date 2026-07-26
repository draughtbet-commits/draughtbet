import { jest } from '@jest/globals';
import cron from 'node-cron';

// Pre-define mock implementations
const mockRedis = {
  zrangebyscore: jest.fn().mockResolvedValue([]),
  zrem: jest.fn().mockResolvedValue(1),
  zscore: jest.fn().mockResolvedValue(null)
};

const mockGameManager = {
  getOpponentId: jest.fn().mockResolvedValue('opponent-id')
};

const mockSettlement = {
  settleGameWithRetry: jest.fn().mockResolvedValue(undefined),
  settleGameDrawWithRetry: jest.fn().mockResolvedValue(undefined)
};

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
};

jest.unstable_mockModule('../../utils/redis.js', () => ({
  default: mockRedis
}));

jest.unstable_mockModule('../../sockets/gameManager.js', () => mockGameManager);
jest.unstable_mockModule('../../sockets/settlement.js', () => mockSettlement);
jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: mockLogger
}));

jest.unstable_mockModule('../../sockets/index.js', () => ({
  getIO: jest.fn(() => ({
    in: jest.fn().mockReturnValue({
      fetchSockets: jest.fn().mockResolvedValue([])
    })
  }))
}));

describe('disconnectSweep', () => {
  let startDisconnectSweep;
  let sweepJob;

  beforeAll(async () => {
    const mod = await import('../disconnectSweep.js');
    startDisconnectSweep = mod.startDisconnectSweep;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(cron, 'schedule').mockImplementation((exp, cb) => {
      sweepJob = cb;
    });
    startDisconnectSweep();
  });

  it('should process remaining entries even if one throws (per-iteration try/catch)', async () => {
    // Return two expired matches
    mockRedis.zrangebyscore.mockResolvedValueOnce([
      'match-1:user-1',
      'match-2:user-2'
    ]);

    // Make the first one throw during processing to simulate an unexpected error
    mockGameManager.getOpponentId.mockRejectedValueOnce(new Error('Unexpected failure on match-1'));
    // Make the second one succeed
    mockGameManager.getOpponentId.mockResolvedValueOnce('opponent-2');

    await sweepJob();

    // Verify it processed match-1 (and failed)
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: 'match-1:user-1'
      }),
      expect.stringContaining('Disconnect sweep: error processing entry')
    );

    // Verify it STILL processed match-2 despite match-1 throwing
    expect(mockSettlement.settleGameWithRetry).toHaveBeenCalledWith('match-2', 'opponent-2', 'user-2', 'forfeit_disconnect');
  });
});
