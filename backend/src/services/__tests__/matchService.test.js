import { jest } from '@jest/globals';

const mockPrisma = {
  $transaction: jest.fn(),
  $queryRaw: jest.fn(),
  user: {
    findUnique: jest.fn()
  },
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
    findFirst: jest.fn(),
    create: jest.fn()
  },
  gameOutbox: {
    create: jest.fn()
  }
};

jest.unstable_mockModule('../../utils/db.js', () => ({
  default: mockPrisma
}));

const { debitStakes, createMatchWithStakes, IdenticalPlayersError } = await import('../matchService.js');

describe('matchService debitStakes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ id: 'w-a', userId: 'player-a', balanceMinorUnits: '100000' }])
      .mockResolvedValueOnce([{ id: 'w-b', userId: 'player-b', balanceMinorUnits: '100000' }]);
  });

  const eligibleUser = {
    countryCode: 'NG',
    kycStatus: 'VERIFIED',
    eligibility: { id: 'elig-1', countryAllowed: true, ageVerified: true }
  };
  mockPrisma.user.findUnique.mockResolvedValue(eligibleUser);

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

    // The durable activation record commits atomically with the reservations
    expect(mockPrisma.gameOutbox.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        matchId: expect.any(String),
        player1Id: 'player-a',
        player2Id: 'player-b',
        tier: 'AMATEUR',
        stakeMinorUnits: 5000n,
        status: 'PENDING'
      })
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

  it('rejects identical light/dark players before touching any wallet', async () => {
    await expect(debitStakes('player-a', 'player-a', 5000n, 'AMATEUR'))
      .rejects.toThrow(IdenticalPlayersError);

    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
    expect(mockPrisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(mockPrisma.match.create).not.toHaveBeenCalled();
  });

  it('exposes the transaction core for reuse inside another transaction', async () => {
    mockPrisma.platformSettings.findUnique.mockResolvedValue({ commissionPercent: 15 });
    mockPrisma.match.create.mockResolvedValue({ id: 'm-shared' });

    const match = await createMatchWithStakes(mockPrisma, 'player-a', 'player-b', 5000n, 'AMATEUR');

    expect(match).toEqual({ id: 'm-shared' });
    expect(mockPrisma.wallet.update).toHaveBeenCalledTimes(2);
    expect(mockPrisma.walletTransaction.create).toHaveBeenCalledTimes(2);
    expect(mockPrisma.match.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ settlementCommissionPercent: 15 })
    });
  });

  it('refuses to fund a match when either player fails KYC', async () => {
    mockPrisma.user.findUnique
      .mockResolvedValueOnce({
        countryCode: 'NG',
        kycStatus: 'NONE',
        eligibility: { id: 'elig-1', countryAllowed: true, ageVerified: true }
      });

    await expect(debitStakes('player-a', 'player-b', 5000n, 'AMATEUR'))
      .rejects.toThrow('KYC verification is required');

    // No wallet row is locked and no stake is taken for the failing pair
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
    expect(mockPrisma.match.create).not.toHaveBeenCalled();
  });

  it('refuses to fund a match for a player with no country evidence', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      countryCode: null,
      kycStatus: 'VERIFIED',
      eligibility: null
    });

    await expect(debitStakes('player-a', 'player-b', 5000n, 'AMATEUR'))
      .rejects.toThrow('Account eligibility has not been verified');

    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    expect(mockPrisma.match.create).not.toHaveBeenCalled();
  });
});