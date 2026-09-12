import { jest } from '@jest/globals';

const mockPrisma = {
  $transaction: jest.fn(),
  $queryRaw: jest.fn(),
  platformSettings: {
    findUnique: jest.fn()
  },
  wallet: {
    update: jest.fn()
  },
  walletTransaction: {
    create: jest.fn()
  },
  match: {
    create: jest.fn()
  }
};

jest.unstable_mockModule('../../utils/db.js', () => ({
  default: mockPrisma
}));

const { debitStakes } = await import('../matchService.js');

describe('matchService debitStakes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ id: 'w-a', userId: 'player-a', balanceMinorUnits: '100000' }])
      .mockResolvedValueOnce([{ id: 'w-b', userId: 'player-b', balanceMinorUnits: '100000' }]);
  });

  it('snapshots the accepted commissionPercent onto the Match row', async () => {
    mockPrisma.platformSettings.findUnique.mockResolvedValue({ commissionPercent: 20 });
    mockPrisma.match.create.mockResolvedValue({ id: 'm-1' });

    // player-a < player-b lexicographically, lock order follows supply order
    const match = await debitStakes('player-a', 'player-b', 5000n, 'AMATEUR');

    expect(mockPrisma.platformSettings.findUnique).toHaveBeenCalledWith({
      where: { id: 'singleton' }
    });
    expect(mockPrisma.match.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: expect.any(String),
        status: 'ACTIVE',
        stakeMinorUnits: 5000n,
        settlementCommissionPercent: 20
      })
    });
    expect(match).toEqual({ id: 'm-1' });

    // Both wallets debited exactly once with a signed STAKE entry each
    expect(mockPrisma.wallet.update).toHaveBeenCalledTimes(2);
    expect(mockPrisma.walletTransaction.create).toHaveBeenCalledTimes(2);
    expect(mockPrisma.walletTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'STAKE', amountMinorUnits: -5000n })
    });
  });

  it('refuses to fund a match without platform settings', async () => {
    mockPrisma.platformSettings.findUnique.mockResolvedValue(null);

    await expect(debitStakes('player-a', 'player-b', 5000n, 'AMATEUR'))
      .rejects.toThrow('Platform settings not configured');

    expect(mockPrisma.match.create).not.toHaveBeenCalled();
    expect(mockPrisma.walletTransaction.create).not.toHaveBeenCalled();
  });

  it('refuses out-of-bounds commission terms before creating the match', async () => {
    mockPrisma.platformSettings.findUnique.mockResolvedValue({ commissionPercent: 120 });

    await expect(debitStakes('player-a', 'player-b', 5000n, 'AMATEUR'))
      .rejects.toThrow('Invalid commissionPercent');

    expect(mockPrisma.match.create).not.toHaveBeenCalled();
  });
});