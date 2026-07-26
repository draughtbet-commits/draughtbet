import { jest } from '@jest/globals';

const mockPrisma = {
  $transaction: jest.fn(),
  match: {
    findUnique: jest.fn(),
    update: jest.fn()
  },
  platformSettings: {
    findUniqueOrThrow: jest.fn()
  },
  wallet: {
    findUniqueOrThrow: jest.fn(),
    update: jest.fn()
  },
  walletTransaction: {
    create: jest.fn(),
    findFirst: jest.fn()
  }
};

const mockRedis = {
  del: jest.fn()
};

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
};

jest.unstable_mockModule('../../utils/db.js', () => ({
  default: mockPrisma
}));

jest.unstable_mockModule('../../utils/redis.js', () => ({
  default: mockRedis
}));

jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: mockLogger
}));

const mockEmit = jest.fn();
const mockTo = jest.fn().mockReturnValue({ emit: mockEmit });

jest.unstable_mockModule('../index.js', () => ({
  getIO: jest.fn(() => ({
    to: mockTo
  }))
}));

describe('settlement logic', () => {
  let settlement;
  let originalSleep;

  beforeAll(async () => {
    originalSleep = setTimeout;
    jest.spyOn(global, 'setTimeout').mockImplementation((cb) => cb());
    settlement = await import('../settlement.js');
  });

  afterAll(() => {
    global.setTimeout = originalSleep;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockEmit.mockClear();
    mockTo.mockClear();
  });

  describe('settleGameWithRetry', () => {
    it('should attempt cleanup if DB transaction committed previously but cleanup was skipped (idempotency gate fires on retry)', async () => {
      // Mock the DB transaction to return null, simulating the idempotency gate firing
      mockPrisma.$transaction.mockResolvedValueOnce(null);

      // And mock the standalone DB cleanup query returning a COMPLETED match
      // The true winner is 'true-winner', endReason is 'true-reason'
      mockPrisma.match.findUnique.mockResolvedValueOnce({
        status: 'COMPLETED',
        stakeMinorUnits: 1000,
        playerLightId: 'light-id',
        playerDarkId: 'dark-id',
        winnerId: 'true-winner',
        endReason: 'true-reason'
      });
      
      // Mock the PAYOUT wallet transaction query
      mockPrisma.walletTransaction.findFirst.mockResolvedValueOnce({
        amountMinorUnits: 1800n
      });

      await settlement.settleGameWithRetry('match-1', 'caller-winner', 'caller-loser', 'caller-reason');

      // It should have called runCleanupFromDbForWin -> notifyAndCleanupWin -> redis.del
      expect(mockRedis.del).toHaveBeenCalledWith('match:match-1');
      expect(mockRedis.del).toHaveBeenCalledWith('user:light-id:activeMatch');
      expect(mockRedis.del).toHaveBeenCalledWith('user:dark-id:activeMatch');

      // Importantly, the socket emit must use 'true-winner', 'true-reason', and '1800' payout.
      expect(mockTo).toHaveBeenCalledWith('match:match-1');
      expect(mockEmit).toHaveBeenCalledWith('match_ended', {
        winnerId: 'true-winner',
        reason: 'true-reason',
        payout: '1800'
      });
    });

    it('should retry if settleGame throws', async () => {
      mockPrisma.$transaction.mockRejectedValueOnce(new Error('DB failure'));
      mockPrisma.$transaction.mockResolvedValueOnce({
        payout: 1800,
        commission: 200,
        match: { playerLightId: 'p1', playerDarkId: 'p2' }
      });

      await settlement.settleGameWithRetry('match-2', 'p1', 'p2', 'forfeit');

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
      expect(mockRedis.del).toHaveBeenCalledWith('match:match-2');
    });
  });
});
