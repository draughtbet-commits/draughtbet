import { jest } from '@jest/globals';

const mockPrisma = {
  $transaction: jest.fn(),
  $queryRaw: jest.fn(),
  match: {
    findUnique: jest.fn(),
    updateMany: jest.fn()
  },
  matchMove: {
    findFirst: jest.fn()
  },
  platformSettings: {
    findUniqueOrThrow: jest.fn(),
    findUnique: jest.fn()
  },
  wallet: {
    update: jest.fn()
  },
  walletTransaction: {
    create: jest.fn(),
    findFirst: jest.fn()
  }
};

const mockRedis = {
  del: jest.fn().mockResolvedValue(1),
  eval: jest.fn().mockResolvedValue(1)
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

const { LIVE_STATUSES } = await import('../../modules/match/service.js');

describe('settlement logic', () => {
  let settlement;
  let outsiderError;
  let invalidSettlementError;
  let originalSleep;

  const activeMatch = (overrides = {}) => ({
    status: 'IN_PLAY',
    stakeMinorUnits: BigInt(1000),
    playerLightId: 'p1',
    playerDarkId: 'p2',
    settlementCommissionPercent: 25,
    ...overrides
  });

  beforeAll(async () => {
    originalSleep = setTimeout;
    jest.spyOn(global, 'setTimeout').mockImplementation((cb) => cb());
    settlement = await import('../settlement.js');
    outsiderError = settlement.OutsiderSettlementError;
    invalidSettlementError = settlement.InvalidSettlementError;
  });

  afterAll(() => {
    global.setTimeout = originalSleep;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockEmit.mockClear();
    mockTo.mockClear();
    mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
  });

  describe('settleGame', () => {
    it('settles a win using the accepted fee snapshot with a single net PAYOUT entry', async () => {
      mockPrisma.match.findUnique.mockResolvedValue(activeMatch());
      mockPrisma.match.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'w-p1', userId: 'p1', balanceMinorUnits: '0' }]);

      const result = await settlement.settleGame('match-1', 'p1', 'p2', 'capture_win');

      // Atomic claim gate
      expect(mockPrisma.match.updateMany).toHaveBeenCalledWith({
        where: { id: 'match-1', status: { in: LIVE_STATUSES } },
        data: {
          status: 'COMPLETED',
          winnerId: 'p1',
          endReason: 'capture_win',
          endedAt: expect.any(Date)
        }
      });

      // Fee from SNAPSHOT (25% -> pot 2000, commission 500, payout 1500),
      // NOT live settings
      expect(mockPrisma.platformSettings.findUnique).not.toHaveBeenCalled();
      expect(result.payout).toBe(1500n);
      expect(result.commission).toBe(500n);
      expect(mockPrisma.wallet.update).toHaveBeenCalledWith({
        where: { id: 'w-p1' },
        data: { balanceMinorUnits: { increment: 1500n } }
      });

      // Exactly one ledger entry: PAYOUT, no COMMISSION row on the player wallet
      expect(mockPrisma.walletTransaction.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.walletTransaction.create).toHaveBeenCalledWith({
        data: {
          walletId: 'w-p1',
          type: 'PAYOUT',
          amountMinorUnits: 1500n,
          relatedMatchId: 'match-1'
        }
      });
      expect(mockRedis.del).toHaveBeenCalledWith('match:match-1');
    });

    it('rejects an outsider winner before any write', async () => {
      mockPrisma.match.findUnique.mockResolvedValue(activeMatch());
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'w-p1' }]);

      await expect(settlement.settleGame('match-1', 'evil-winner', 'p2', 'capture_win'))
        .rejects.toThrow(outsiderError);

      expect(mockPrisma.match.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
      expect(mockPrisma.walletTransaction.create).not.toHaveBeenCalled();
    });

    it('rejects a mismatched loser before any write', async () => {
      mockPrisma.match.findUnique.mockResolvedValue(activeMatch());
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'w-p1' }]);

      await expect(settlement.settleGame('match-1', 'p1', 'evil-loser', 'capture_win'))
        .rejects.toThrow(invalidSettlementError);

      expect(mockPrisma.match.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
    });

    it('returns null when another settlement already claimed the match', async () => {
      mockPrisma.match.findUnique.mockResolvedValue(activeMatch());
      mockPrisma.match.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'w-p1' }]);

      const result = await settlement.settleGame('match-1', 'p1', 'p2', 'capture_win');

      expect(result).toBeNull();
      expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
      expect(mockPrisma.walletTransaction.create).not.toHaveBeenCalled();
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('returns null for a missing or already-completed match', async () => {
      mockPrisma.match.findUnique.mockResolvedValue({ status: 'COMPLETED' });

      const result = await settlement.settleGame('match-1', 'p1', 'p2', 'capture_win');
      expect(result).toBeNull();
      expect(mockPrisma.match.updateMany).not.toHaveBeenCalled();
    });

    it('falls back to live settings only for legacy matches without a fee snapshot', async () => {
      mockPrisma.match.findUnique.mockResolvedValue(
        activeMatch({ settlementCommissionPercent: null })
      );
      mockPrisma.match.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.platformSettings.findUnique.mockResolvedValue({ commissionPercent: 10 });
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'w-p1', userId: 'p1', balanceMinorUnits: '0' }]);

      const result = await settlement.settleGame('match-legacy', 'p1', 'p2', 'recovery_sweep');

      expect(mockPrisma.platformSettings.findUnique).toHaveBeenCalledWith({
        where: { id: 'singleton' }
      });
      expect(result.payout).toBe(1800n);
    });

    it('refuses an out-of-bounds fee snapshot without touching the ledger', async () => {
      mockPrisma.match.findUnique.mockResolvedValue(activeMatch({ settlementCommissionPercent: 150 }));
      mockPrisma.match.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'w-p1' }]);

      await expect(settlement.settleGame('match-1', 'p1', 'p2', 'capture_win'))
        .rejects.toThrow(invalidSettlementError);

      expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
      expect(mockPrisma.walletTransaction.create).not.toHaveBeenCalled();
    });

    it('refuses a board-derived win claim when the durable move log is empty', async () => {
      mockPrisma.match.findUnique.mockResolvedValue(activeMatch());
      mockPrisma.matchMove.findFirst.mockResolvedValue(null);

      await expect(settlement.settleGame('match-1', 'p1', 'p2', 'NO_LEGAL_MOVES'))
        .rejects.toThrow(invalidSettlementError);

      expect(mockPrisma.match.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
      expect(mockPrisma.walletTransaction.create).not.toHaveBeenCalled();
    });

    it('settles a board-derived win claim when the final move is on the durable log', async () => {
      mockPrisma.match.findUnique.mockResolvedValue(activeMatch());
      mockPrisma.matchMove.findFirst.mockResolvedValue({ id: 'mv-1', moveNumber: 42 });
      mockPrisma.match.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'w-p1', userId: 'p1', balanceMinorUnits: '0' }]);

      const result = await settlement.settleGame('match-1', 'p1', 'p2', 'NO_LEGAL_MOVES');

      expect(mockPrisma.matchMove.findFirst).toHaveBeenCalledWith({
        where: { matchId: 'match-1' },
        orderBy: { moveNumber: 'desc' }
      });
      expect(result).not.toBeNull();
    });
  });

  describe('settleGameDraw', () => {
    it('claims atomically and issues exactly one REFUND entry per player', async () => {
      mockPrisma.match.findUnique.mockResolvedValue(activeMatch());
      mockPrisma.match.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([{ id: 'w-light', userId: 'p1', balanceMinorUnits: '0' }])
        .mockResolvedValueOnce([{ id: 'w-dark', userId: 'p2', balanceMinorUnits: '0' }]);

      const result = await settlement.settleGameDraw('match-1', 'draw_threefold');

      expect(mockPrisma.match.updateMany).toHaveBeenCalledWith({
        where: { id: 'match-1', status: { in: LIVE_STATUSES } },
        data: expect.objectContaining({ status: 'COMPLETED', endReason: 'draw_threefold' })
      });
      expect(result).not.toBeNull();
      expect(mockPrisma.wallet.update).toHaveBeenCalledTimes(2);
      expect(mockPrisma.walletTransaction.create).toHaveBeenCalledTimes(2);
      expect(mockPrisma.walletTransaction.create).toHaveBeenCalledWith({
        data: {
          walletId: 'w-light',
          type: 'REFUND',
          amountMinorUnits: 1000n,
          relatedMatchId: 'match-1'
        }
      });
      // Draw emits both wallet_updated events
      expect(mockRedis.del).toHaveBeenCalledWith('match:match-1');
    });

    it('returns null when a win claimed the match first', async () => {
      mockPrisma.match.findUnique.mockResolvedValue(activeMatch());
      mockPrisma.match.updateMany.mockResolvedValue({ count: 0 });

      const result = await settlement.settleGameDraw('match-1', 'draw_threefold');
      expect(result).toBeNull();
      expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('refuses a board-derived draw claim when the durable move log is empty', async () => {
      mockPrisma.match.findUnique.mockResolvedValue(activeMatch());
      mockPrisma.matchMove.findFirst.mockResolvedValue(null);

      await expect(settlement.settleGameDraw('match-1', 'DRAW_THREEFOLD'))
        .rejects.toThrow(invalidSettlementError);

      expect(mockPrisma.match.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
      expect(mockPrisma.walletTransaction.create).not.toHaveBeenCalled();
    });
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
      // The activeMatch pointers are removed via compare-and-delete (only when
      // they still point at this match), not by an unconditional del.
      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.stringContaining('if redis.call'),
        1,
        'user:light-id:activeMatch',
        'match-1'
      );
      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.stringContaining('if redis.call'),
        1,
        'user:dark-id:activeMatch',
        'match-1'
      );

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