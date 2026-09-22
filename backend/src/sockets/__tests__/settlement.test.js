import { jest } from '@jest/globals';

const mockPrisma = {
  match: { findUnique: jest.fn() },
  matchSettlement: { findUnique: jest.fn() },
  matchReceipt: { findUnique: jest.fn().mockResolvedValue({ id: 'r1' }) }
};

const mockRedis = {
  del: jest.fn().mockResolvedValue(1),
  eval: jest.fn().mockResolvedValue(1),
  hget: jest.fn().mockResolvedValue('3')
};

jest.unstable_mockModule('../../utils/db.js', () => ({
  default: mockPrisma
}));

jest.unstable_mockModule('../../utils/redis.js', () => ({
  default: mockRedis
}));

jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

const mockEmit = jest.fn();
const mockTo = jest.fn().mockReturnValue({ emit: mockEmit });
jest.unstable_mockModule('../index.js', () => ({
  getIO: jest.fn(() => ({ to: mockTo }))
}));

jest.unstable_mockModule('../../modules/notification/service.js', () => ({
  NotificationService: { create: jest.fn().mockResolvedValue({}) }
}));

const mockSettleMatch = jest.fn();
jest.unstable_mockModule('../../modules/settlement/service.js', () => ({
  settleMatch: mockSettleMatch,
  SettlementService: { settleMatch: mockSettleMatch },
  DEFAULT_SETTLEMENT_RETRIES: 10,
  OutsiderSettlementError: class OutsiderSettlementError extends Error { name = 'OutsiderSettlementError'; },
  InvalidSettlementError: class InvalidSettlementError extends Error { name = 'InvalidSettlementError'; }
}));

const settlement = await import('../settlement.js');
const { OutsiderSettlementError, InvalidSettlementError } = await import('../../modules/settlement/service.js');

const matchRows = {
  inPlay: {
    status: 'IN_PLAY',
    playerLightId: 'p1',
    playerDarkId: 'p2',
    winnerId: null,
    endReason: null,
    stakeMinorUnits: BigInt(100_000)
  },
  settled: {
    status: 'SETTLED',
    playerLightId: 'p1',
    playerDarkId: 'p2',
    winnerId: 'p1',
    endReason: 'NO_LEGAL_MOVES',
    stakeMinorUnits: BigInt(100_000)
  }
};

beforeEach(() => {
  jest.clearAllMocks();
  // Collapse the sleep between retries so 10x retry tests run instantly.
  jest.spyOn(global, 'setTimeout').mockImplementation((cb) => cb());
});

const claimedResult = (payout = 180_000n) => ({
  claimed: true,
  replayed: false,
  payout,
  commission: 20_000n,
  match: matchRows.inPlay,
  settlement: { id: 's1', netPayoutMinorUnits: payout, status: 'SETTLED', endReason: 'NO_LEGAL_MOVES' }
});

const replayResult = (payout = 180_000n) => ({
  claimed: false,
  replayed: true,
  payout,
  commission: 20_000n,
  match: matchRows.inPlay,
  settlement: { id: 's1', netPayoutMinorUnits: payout, status: 'SETTLED', endReason: 'NO_LEGAL_MOVES' }
});

describe('settlement socket layer', () => {
  describe('settleGame', () => {
    it('delegates to SettlementService and emits notifications on a fresh claim', async () => {
      mockSettleMatch.mockResolvedValue(claimedResult());

      const result = await settlement.settleGame('m1', 'p1', 'p2', 'NO_LEGAL_MOVES');

      expect(mockSettleMatch).toHaveBeenCalledWith('m1', {
        result: 'WIN',
        winnerId: 'p1',
        loserId: 'p2',
        endReason: 'NO_LEGAL_MOVES'
      });
      expect(result.payout).toBe(180_000n);
      expect(mockTo).toHaveBeenCalledWith('match:m1');
      expect(mockEmit).toHaveBeenCalledWith('match_ended', expect.objectContaining({ winnerId: 'p1' }));
    });

    it('runs cleanup from DB when the idempotency gate fires', async () => {
      mockSettleMatch.mockResolvedValue(replayResult());
      mockPrisma.match.findUnique.mockResolvedValue(matchRows.settled);
      mockPrisma.matchSettlement.findUnique.mockResolvedValue({
        winnerId: 'p1', netPayoutMinorUnits: 180_000n, endReason: 'NO_LEGAL_MOVES'
      });

      await settlement.settleGame('m1', 'p1', 'p2', 'NO_LEGAL_MOVES');

      expect(mockPrisma.matchSettlement.findUnique).toHaveBeenCalledWith({ where: { matchId: 'm1' } });
      expect(mockTo).toHaveBeenCalledWith('match:m1');
      expect(mockEmit).toHaveBeenCalledWith('match_ended', expect.objectContaining({ winnerId: 'p1' }));
    });
  });

  describe('settleGameWithRetry', () => {
    it('credits the winner exactly once after transient failures then success', async () => {
      const error = new Error('transient');
      mockSettleMatch
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(claimedResult());

      await settlement.settleGameWithRetry('m1', 'p1', 'p2', 'resign', 3);

      expect(mockSettleMatch).toHaveBeenCalledTimes(3);
      // Terminal events are broadcast exactly once per settled match:
      // legacy match_ended + V2 match.finished + settlement.completed (the
      // durable wallet_updated + notifications live in the outbox, not here).
      expect(mockEmit).toHaveBeenCalledTimes(3);
      expect(mockEmit).toHaveBeenCalledWith('match_ended', expect.objectContaining({ winnerId: 'p1' }));
      expect(mockEmit).toHaveBeenCalledWith('match.finished', expect.objectContaining({
        matchId: 'm1',
        result: 'WIN',
        terminalReason: 'resign',
        stateVersion: 3,
        settlementStatus: 'settled',
        winnerId: 'p1'
      }));
      expect(mockEmit).toHaveBeenCalledWith('settlement.completed', {
        matchId: 'm1',
        receiptId: 'r1'
      });
    });

    it('does not retry on validated-rejectable errors', async () => {
      mockSettleMatch.mockRejectedValue(new OutsiderSettlementError());

      await expect(settlement.settleGameWithRetry('m1', 'outsider', 'p2', 'resign', 3))
        .rejects.toThrow(OutsiderSettlementError);

      expect(mockSettleMatch).toHaveBeenCalledTimes(1);
    });
  });

  describe('settleGameDrawWithRetry', () => {
    it('retries up to 10 times by default', async () => {
      mockSettleMatch.mockRejectedValue(new Error('db'));
      await settlement.settleGameDrawWithRetry('m1', 'draw_threefold');
      expect(mockSettleMatch).toHaveBeenCalledTimes(10);
    });
  });
});