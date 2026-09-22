import { jest } from '@jest/globals';

const mockPrisma = {
  $transaction: jest.fn(),
  match: {
    findUnique: jest.fn(),
    updateMany: jest.fn()
  },
  matchMove: { findFirst: jest.fn() },
  platformSettings: { findUnique: jest.fn() },
  matchSettlement: { findUnique: jest.fn(), create: jest.fn() },
  matchReceipt: { createMany: jest.fn() },
  stakeReservation: { updateMany: jest.fn() },
  notification: {
    create: jest.fn(({ data }) => ({ id: 'notif-1', ...data, createdAt: new Date() }))
  },
  wallet: { findUnique: jest.fn(() => ({ id: 'wallet-1', currency: 'NGN' })) },
  outboxEvent: {
    create: jest.fn(({ data }) => ({ id: 'ob-1', ...data })),
    findUnique: jest.fn(() => null)
  }
};

jest.unstable_mockModule('../../../utils/db.js', () => ({
  default: mockPrisma
}));

jest.unstable_mockModule('../../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

const mockPostSettlementWin = jest.fn().mockResolvedValue({ replayed: false });
const mockPostSettlementDraw = jest.fn().mockResolvedValue({ replayed: false });
jest.unstable_mockModule('../../../services/ledgerService.js', () => ({
  postSettlementWin: mockPostSettlementWin,
  postSettlementDraw: mockPostSettlementDraw
}));

const { settleMatch, OutsiderSettlementError, InvalidSettlementError, MatchNotSettleableError } = await import('../service.js');

const IN_PLAY_MATCH = {
  status: 'IN_PLAY',
  stakeMinorUnits: BigInt(100_000),
  playerLightId: 'player-1',
  playerDarkId: 'player-2',
  settlementCommissionPercent: 10
};

const activeMatch = (overrides = {}) => ({ ...IN_PLAY_MATCH, ...overrides });

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
  // Board-derived outcomes need a durable final move as evidence.
  mockPrisma.matchMove.findFirst.mockResolvedValue({ moveNumber: 1 });
});

describe('SettlementService', () => {
  describe('settleMatch — win', () => {
    it('settles a win using the frozen fee snapshot and credits winner exactly once', async () => {
      mockPrisma.match.findUnique.mockResolvedValue(activeMatch());
      mockPrisma.match.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.matchSettlement.findUnique.mockResolvedValue(null);
      mockPrisma.matchSettlement.create.mockResolvedValue({ id: 'set-1', matchId: 'm1', netPayoutMinorUnits: 180_000n });

      const result = await settleMatch('m1', { result: 'WIN', winnerId: 'player-1', loserId: 'player-2', endReason: 'NO_LEGAL_MOVES' });

      expect(result.claimed).toBe(true);
      expect(result.replayed).toBe(false);

      // claim gate: LIVE -> SETTLED
      expect(mockPrisma.match.updateMany).toHaveBeenCalledWith({
        where: { id: 'm1', status: { in: ['ACTIVE', 'IN_PLAY'] } },
        data: expect.objectContaining({ status: 'SETTLED', winnerId: 'player-1', endReason: 'NO_LEGAL_MOVES' })
      });

      // frozen 10%: pot 200_000, commission 20_000, payout 180_000
      expect(result.payout).toBe(180_000n);
      expect(result.commission).toBe(20_000n);

      // ledger posting
      expect(mockPostSettlementWin).toHaveBeenCalledTimes(1);
      expect(mockPostSettlementWin).toHaveBeenCalledWith(
        mockPrisma,
        'm1',
        expect.objectContaining({
          winnerId: 'player-1',
          netPayoutMinorUnits: 180_000n,
          commissionMinorUnits: 20_000n
        })
      );

      // receipt
      expect(mockPrisma.matchReceipt.createMany).toHaveBeenCalledTimes(1);
      const receipts = mockPrisma.matchReceipt.createMany.mock.calls[0][0].data;
      expect(receipts).toHaveLength(2);
      const winnerReceipt = receipts.find((r) => r.userId === 'player-1');
      expect(winnerReceipt.payoutMinorUnits).toBe(180_000n);
      expect(winnerReceipt.feeMinorUnits).toBe(20_000n);
      const loserReceipt = receipts.find((r) => r.userId === 'player-2');
      expect(loserReceipt.payoutMinorUnits).toBe(0n);

      // reservation lifecycle completes in the same tx
      expect(mockPrisma.stakeReservation.updateMany).toHaveBeenCalledWith({
        where: { matchId: 'm1' },
        data: { status: 'SETTLED' }
      });

      // durable delivery events for the drainer: win/loss notifications +
      // winner wallet.updated, atomic with the claim
      const enqueued = mockPrisma.outboxEvent.create.mock.calls.map(([args]) => args.data);
      expect(enqueued.length).toBe(3);
      expect(enqueued).toContainEqual(expect.objectContaining({ eventType: 'wallet.updated', dedupeKey: 'wallet:settle:m1:player-1' }));
      expect(enqueued).toContainEqual(expect.objectContaining({ eventType: 'notification', dedupeKey: 'notify:settle:m1:player-1:MATCH_ENDED_WIN' }));
      expect(enqueued).toContainEqual(expect.objectContaining({ eventType: 'notification', dedupeKey: 'notify:settle:m1:player-2:MATCH_ENDED_LOSS' }));
    });
  });

  describe('settleMatch — draw', () => {
    it('returns full stake to both players on a draw', async () => {
      mockPrisma.match.findUnique.mockResolvedValue(activeMatch());
      mockPrisma.match.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.matchSettlement.findUnique.mockResolvedValue(null);
      mockPrisma.matchSettlement.create.mockResolvedValue({ id: 'set-2', matchId: 'm1', netPayoutMinorUnits: 0n });

      const result = await settleMatch('m1', { result: 'DRAW', endReason: 'DRAW_THREEFOLD' });

      expect(result.claimed).toBe(true);
      // A draw returns the whole pot and charges no commission.
      expect(result.payout).toBe(200_000n);
      expect(result.commission).toBe(0n);

      expect(mockPostSettlementDraw).toHaveBeenCalledTimes(1);
      expect(mockPostSettlementWin).not.toHaveBeenCalled();

      // record carries the total returned (pot), not a win-style discounted value
      expect(mockPrisma.matchSettlement.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ netPayoutMinorUnits: 200_000n }) })
      );

      // receipts: both get stake back
      const receipts = mockPrisma.matchReceipt.createMany.mock.calls[0][0].data;
      expect(receipts.every((r) => r.payoutMinorUnits === 100_000n && r.feeMinorUnits === 0n)).toBe(true);

      expect(mockPrisma.stakeReservation.updateMany).toHaveBeenCalledWith({
        where: { matchId: 'm1' },
        data: { status: 'SETTLED' }
      });

      // draw refunds both players via durable wallet.updated events (no notices)
      const enqueued = mockPrisma.outboxEvent.create.mock.calls.map(([args]) => args.data);
      expect(enqueued.length).toBe(2);
      expect(enqueued.every((e) => e.eventType === 'wallet.updated')).toBe(true);
      expect(enqueued).toContainEqual(expect.objectContaining({ dedupeKey: 'wallet:settle:m1:player-1' }));
      expect(enqueued).toContainEqual(expect.objectContaining({ dedupeKey: 'wallet:settle:m1:player-2' }));
    });
  });

  describe('settleMatch — legacy fallback', () => {
    it('falls back to live settings when settlementCommissionPercent is null', async () => {
      mockPrisma.match.findUnique.mockResolvedValue(activeMatch({ settlementCommissionPercent: null }));
      mockPrisma.platformSettings.findUnique.mockResolvedValue({ commissionPercent: 15 });
      mockPrisma.match.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.matchSettlement.findUnique.mockResolvedValue(null);
      mockPrisma.matchSettlement.create.mockResolvedValue({ id: 'set-3', netPayoutMinorUnits: 170_000n });

      const result = await settleMatch('m1', { result: 'WIN', winnerId: 'player-1', loserId: 'player-2', endReason: 'forfeit_disconnect' });

      expect(mockPrisma.platformSettings.findUnique).toHaveBeenCalledWith({ where: { id: 'singleton' } });
      // 15% of 200_000 = 30_000 commission, 170_000 payout
      expect(result.payout).toBe(170_000n);
      expect(result.commission).toBe(30_000n);
      expect(mockPrisma.matchSettlement.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ feeSnapshotBps: 15 }) })
      );
    });
  });

  describe('settleMatch — rejection before any write', () => {
    it('throws OutsiderSettlementError for a non-participant winner', async () => {
      mockPrisma.match.findUnique.mockResolvedValue(activeMatch());
      await expect(settleMatch('m1', { result: 'WIN', winnerId: 'outsider', endReason: 'resign' }))
        .rejects.toThrow(OutsiderSettlementError);
      expect(mockPrisma.match.updateMany).not.toHaveBeenCalled();
    });

    it('throws InvalidSettlementError when board outcome lacks evidence', async () => {
      mockPrisma.match.findUnique.mockResolvedValue(activeMatch());
      mockPrisma.matchMove.findFirst.mockResolvedValue(null);
      await expect(settleMatch('m1', { result: 'WIN', winnerId: 'player-1', loserId: 'player-2', endReason: 'NO_LEGAL_MOVES' }))
        .rejects.toThrow(InvalidSettlementError);
      expect(mockPrisma.match.updateMany).not.toHaveBeenCalled();
    });

    it('throws InvalidSettlementError when a draw names a winner', async () => {
      mockPrisma.match.findUnique.mockResolvedValue(activeMatch());
      await expect(settleMatch('m1', { result: 'DRAW', winnerId: 'player-1', endReason: 'draw_threefold' }))
        .rejects.toThrow(InvalidSettlementError);
    });
  });

  describe('settleMatch — replay idempotency', () => {
    it('returns the existing settlement when the claim gate fires (count = 0)', async () => {
      mockPrisma.match.findUnique.mockResolvedValue(activeMatch());
      mockPrisma.match.updateMany.mockResolvedValue({ count: 0 });
      const existing = { matchId: 'm1', netPayoutMinorUnits: 180_000n, status: 'SETTLED', feeSnapshotBps: 10, endReason: 'NO_LEGAL_MOVES' };
      mockPrisma.matchSettlement.findUnique.mockResolvedValue(existing);

      const result = await settleMatch('m1', { result: 'WIN', winnerId: 'player-1', loserId: 'player-2', endReason: 'NO_LEGAL_MOVES' });

      expect(result.claimed).toBe(false);
      expect(result.replayed).toBe(true);
      expect(result.settlement).toBe(existing);
      // No financial writes
      expect(mockPostSettlementWin).not.toHaveBeenCalled();
    });

    it('returns replayed when match is already SETTLED (no live status)', async () => {
      mockPrisma.match.findUnique.mockResolvedValue({ ...IN_PLAY_MATCH, status: 'SETTLED' });
      const existing = { matchId: 'm1', netPayoutMinorUnits: 180_000n, status: 'SETTLED', feeSnapshotBps: 10, endReason: 'NO_LEGAL_MOVES' };
      mockPrisma.matchSettlement.findUnique.mockResolvedValue(existing);

      const result = await settleMatch('m1', { result: 'WIN', winnerId: 'player-1', loserId: 'player-2', endReason: 'NO_LEGAL_MOVES' });
      expect(result.claimed).toBe(false);
      expect(result.replayed).toBe(true);
    });

    it('throws when non-live and no settlement record exists', async () => {
      mockPrisma.match.findUnique.mockResolvedValue({ ...IN_PLAY_MATCH, status: 'RELEASED' });
      mockPrisma.matchSettlement.findUnique.mockResolvedValue(null);
      await expect(settleMatch('m1', { result: 'WIN', winnerId: 'player-1', loserId: 'player-2', endReason: 'forfeit' }))
        .rejects.toThrow(MatchNotSettleableError);
    });
  });

  describe('settleMatch — missing match', () => {
    it('throws MatchNotSettleableError when match does not exist', async () => {
      mockPrisma.match.findUnique.mockResolvedValue(null);
      await expect(settleMatch('nope', { result: 'DRAW', endReason: 'draw' }))
        .rejects.toThrow(MatchNotSettleableError);
    });
  });
});