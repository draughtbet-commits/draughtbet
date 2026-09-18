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
  ledgerAccount: {
    upsert: jest.fn(),
    findMany: jest.fn()
  },
  ledgerTransaction: {
    create: jest.fn(),
    findUnique: jest.fn()
  },
  ledgerEntry: {
    create: jest.fn(),
    aggregate: jest.fn()
  },
  match: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn()
  },
  stakeReservation: {
    findUnique: jest.fn(),
    create: jest.fn()
  },
  gameOutbox: {
    create: jest.fn()
  }
};

jest.unstable_mockModule('../../utils/db.js', () => ({
  default: mockPrisma
}));

const { debitStakes, createMatchWithStakes, InsufficientFundsError, IdenticalPlayersError } = await import('../matchService.js');
const {
  SelfExcludedError,
  TimeoutActiveError,
  StakeLimitExceededError
} = await import('../eligibilityService.js');

describe('matchService debitStakes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
    // Wallet rows are locked via FOR UPDATE; they no longer carry the balance.
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ id: 'w-a', userId: 'player-a', currency: 'NGN' }])
      .mockResolvedValueOnce([{ id: 'w-b', userId: 'player-b', currency: 'NGN' }]);
    // V2 ledger mocks: the affordability check reads PLAYER_AVAILABLE nets.
    mockPrisma.ledgerAccount.findMany.mockImplementation(async ({ where }) => {
      if (where.type === 'PLAYER_AVAILABLE') return [{ id: `acc:avail:${where.userId}` }];
      return [];
    });
    mockPrisma.ledgerEntry.aggregate.mockResolvedValue({ _sum: { amountMinorUnits: 100000n } });
    // Ledger accounts are created via atomic raw upserts (not Prisma upsert).
    mockPrisma.$queryRaw.mockImplementation(async (_strings, ...values) => {
      if (values.length === 4) {
        const [id, userId, type, currency] = values;
        return [{ id, userId, type, currency }];
      }
      const [id, type, currency] = values;
      return [{ id, userId: null, type, currency }];
    });
    mockPrisma.ledgerTransaction.findUnique.mockResolvedValue(null);
    mockPrisma.ledgerTransaction.create.mockResolvedValue({ id: 'ledger-tx-1', type: 'STAKE_LOCK' });
    mockPrisma.ledgerEntry.create.mockImplementation(async ({ data }) => ({ id: `entry:${data.accountId}` }));
    // Lifecycle mocks: no pre-terminal match blocks funding; OPEN is the
    // created status transitioned to FUNDED after both stakes are reserved.
    mockPrisma.match.findFirst.mockResolvedValue(null);
    mockPrisma.match.findUnique.mockResolvedValue({ status: 'OPEN' });
    mockPrisma.match.update.mockImplementation(async ({ data }) => ({ id: 'm-1', ...data }));
    mockPrisma.stakeReservation.findUnique.mockResolvedValue(null);
    mockPrisma.stakeReservation.create.mockImplementation(async ({ data }) => ({ ...data, id: `sr:${data.userId}` }));
  });

  const eligibleUser = {
    countryCode: 'NG',
    kycStatus: 'VERIFIED',
    eligibility: { id: 'elig-1', countryAllowed: true, ageVerified: true }
  };
  mockPrisma.user.findUnique.mockResolvedValue(eligibleUser);

  it('snapshots the accepted commissionPercent and time control onto the Match row', async () => {
    mockPrisma.platformSettings.findUnique.mockResolvedValue({ commissionPercent: 20, timeControlSeconds: 45 });
    mockPrisma.match.create.mockResolvedValue({ id: 'm-1', status: 'OPEN' });

    // player-a < player-b lexicographically, lock order follows supply order
    const match = await debitStakes('player-a', 'player-b', 5000n, 'AMATEUR');

    expect(mockPrisma.platformSettings.findUnique).toHaveBeenCalledWith({
      where: { id: 'singleton' }
    });
    expect(mockPrisma.match.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: expect.any(String),
        status: 'OPEN',
        playerLightId: 'player-a',
        playerDarkId: 'player-b',
        currency: 'NGN',
        stakeMinorUnits: 5000n,
        settlementCommissionPercent: 20,
        timeControlSeconds: 45,
        participants: {
          create: [
            { userId: 'player-a', side: 'LIGHT' },
            { userId: 'player-b', side: 'DARK' }
          ]
        }
      })
    });

    // Both stakes reserved -> OPEN -> FUNDED in the same tx
    expect(mockPrisma.match.update).toHaveBeenCalledWith({
      where: { id: expect.any(String) },
      data: { status: 'FUNDED' }
    });
    expect(mockPrisma.stakeReservation.create).toHaveBeenCalledTimes(2);
    expect(match).toEqual({ id: 'm-1', status: 'FUNDED' });

    // Affordability is read from the V2 ledger PLAYER_AVAILABLE net, under the
    // wallet row locks (no wallet balance is consulted).
    expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
    expect(mockPrisma.ledgerEntry.aggregate).toHaveBeenCalledTimes(2);

    // ONE balanced STAKE_LOCK posting with a 4-entry net-zero set
    // (AVAILABLE -5000 -> LOCKED +5000 for each player) in the same tx.
    expect(mockPrisma.ledgerTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'STAKE_LOCK' })
    });
    expect(mockPrisma.ledgerEntry.create).toHaveBeenCalledTimes(4);
    const entryAmounts = mockPrisma.ledgerEntry.create.mock.calls.map(([c]) => c.data.amountMinorUnits);
    expect(entryAmounts).toEqual([-5000n, 5000n, -5000n, 5000n]);

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

  it('refuses to fund when either player cannot cover the stake on the ledger', async () => {
    mockPrisma.platformSettings.findUnique.mockResolvedValue({ commissionPercent: 10 });
    mockPrisma.match.create.mockResolvedValue({ id: 'm-1', status: 'OPEN' });
    // The first PLAYER_AVAILABLE read clears the stake; the second does not.
    mockPrisma.ledgerEntry.aggregate
      .mockResolvedValueOnce({ _sum: { amountMinorUnits: 100000n } })
      .mockResolvedValueOnce({ _sum: { amountMinorUnits: 1000n } });

    await expect(debitStakes('player-a', 'player-b', 5000n, 'AMATEUR'))
      .rejects.toThrow(InsufficientFundsError);

    // Nothing was committed: no match, no reservation, no ledger posting.
    expect(mockPrisma.match.create).not.toHaveBeenCalled();
    expect(mockPrisma.stakeReservation.create).not.toHaveBeenCalled();
    expect(mockPrisma.ledgerTransaction.create).not.toHaveBeenCalled();
    expect(mockPrisma.gameOutbox.create).not.toHaveBeenCalled();
  });

  it('refuses to fund a match without platform settings', async () => {
    mockPrisma.platformSettings.findUnique.mockResolvedValue(null);

    await expect(debitStakes('player-a', 'player-b', 5000n, 'AMATEUR'))
      .rejects.toThrow('Platform settings not configured');

    expect(mockPrisma.match.create).not.toHaveBeenCalled();
    expect(mockPrisma.ledgerTransaction.create).not.toHaveBeenCalled();
  });

  it('refuses out-of-bounds commission terms before creating the match', async () => {
    mockPrisma.platformSettings.findUnique.mockResolvedValue({ commissionPercent: 120 });

    await expect(debitStakes('player-a', 'player-b', 5000n, 'AMATEUR'))
      .rejects.toThrow('Invalid commissionPercent');

    expect(mockPrisma.match.create).not.toHaveBeenCalled();
    expect(mockPrisma.ledgerTransaction.create).not.toHaveBeenCalled();
  });

  it('rejects identical light/dark players before touching any wallet', async () => {
    await expect(debitStakes('player-a', 'player-a', 5000n, 'AMATEUR'))
      .rejects.toThrow(IdenticalPlayersError);

    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    expect(mockPrisma.match.create).not.toHaveBeenCalled();
    expect(mockPrisma.ledgerTransaction.create).not.toHaveBeenCalled();
  });

  it('exposes the transaction core for reuse inside another transaction', async () => {
    mockPrisma.platformSettings.findUnique.mockResolvedValue({ commissionPercent: 15 });
    mockPrisma.match.create.mockResolvedValue({ id: 'm-shared', status: 'OPEN' });
    mockPrisma.match.update.mockResolvedValue({ id: 'm-shared', status: 'FUNDED' });

    const match = await createMatchWithStakes(mockPrisma, 'player-a', 'player-b', 5000n, 'AMATEUR');

    expect(match).toEqual({ id: 'm-shared', status: 'FUNDED' });
    expect(mockPrisma.stakeReservation.create).toHaveBeenCalledTimes(2);
    expect(mockPrisma.ledgerTransaction.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.match.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ settlementCommissionPercent: 15, timeControlSeconds: 60 })
    });
  });

  it('refuses an out-of-bounds time control snapshot before creating the match', async () => {
    mockPrisma.platformSettings.findUnique.mockResolvedValue({ commissionPercent: 10, timeControlSeconds: 0 });

    await expect(debitStakes('player-a', 'player-b', 5000n, 'AMATEUR'))
      .rejects.toThrow('Invalid timeControlSeconds');

    expect(mockPrisma.match.create).not.toHaveBeenCalled();
    expect(mockPrisma.ledgerTransaction.create).not.toHaveBeenCalled();
  });

  it('allows funding a match without KYC (KYC gates money-out only)', async () => {
    mockPrisma.platformSettings.findUnique.mockResolvedValue({ commissionPercent: 10 });
    mockPrisma.match.create.mockResolvedValue({ id: 'm-1', status: 'OPEN' });
    mockPrisma.user.findUnique
      .mockResolvedValueOnce({
        countryCode: 'NG',
        kycStatus: 'NONE',
        isBanned: false,
        eligibility: { id: 'elig-1', countryAllowed: true, ageVerified: true }
      });

    const match = await debitStakes('player-a', 'player-b', 5000n, 'AMATEUR');

    expect(match).toEqual({ id: 'm-1', status: 'FUNDED' });
    // No wallet row is locked for the failing pair up front — the player is
    // allowed to play without KYC, so funding proceeds normally.
    expect(mockPrisma.stakeReservation.create).toHaveBeenCalledTimes(2);
  });

  it('refuses to fund a match when either player is self-excluded', async () => {
    mockPrisma.platformSettings.findUnique.mockResolvedValue({ commissionPercent: 10 });
    mockPrisma.match.create.mockResolvedValue({ id: 'm-1', status: 'OPEN' });
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      countryCode: 'NG',
      kycStatus: 'VERIFIED',
      isBanned: false,
      eligibility: { id: 'elig-1', countryAllowed: true, ageVerified: true },
      saferPlayProfile: {
        stakeLimitMinorUnits: null,
        timeoutUntil: null,
        selfExcludedUntil: new Date(Date.now() + 7 * 86_400_000)
      }
    });

    await expect(debitStakes('player-a', 'player-b', 5000n, 'AMATEUR'))
      .rejects.toThrow(SelfExcludedError);

    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    expect(mockPrisma.match.create).not.toHaveBeenCalled();
    expect(mockPrisma.ledgerTransaction.create).not.toHaveBeenCalled();
  });

  it('refuses to fund a match while either player is on a timeout', async () => {
    mockPrisma.platformSettings.findUnique.mockResolvedValue({ commissionPercent: 10 });
    mockPrisma.match.create.mockResolvedValue({ id: 'm-1', status: 'OPEN' });
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      countryCode: 'NG',
      kycStatus: 'VERIFIED',
      isBanned: false,
      eligibility: { id: 'elig-1', countryAllowed: true, ageVerified: true },
      saferPlayProfile: {
        stakeLimitMinorUnits: null,
        timeoutUntil: new Date(Date.now() + 60 * 60 * 1000),
        selfExcludedUntil: null
      }
    });

    await expect(debitStakes('player-a', 'player-b', 5000n, 'AMATEUR'))
      .rejects.toThrow(TimeoutActiveError);

    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    expect(mockPrisma.match.create).not.toHaveBeenCalled();
  });

  it('refuses to fund a match when a stake exceeds the player safer-play limit', async () => {
    mockPrisma.platformSettings.findUnique.mockResolvedValue({ commissionPercent: 10 });
    mockPrisma.match.create.mockResolvedValue({ id: 'm-1', status: 'OPEN' });
    mockPrisma.user.findUnique.mockResolvedValueOnce({
      countryCode: 'NG',
      kycStatus: 'VERIFIED',
      isBanned: false,
      eligibility: { id: 'elig-1', countryAllowed: true, ageVerified: true },
      saferPlayProfile: {
        stakeLimitMinorUnits: 1000n,
        timeoutUntil: null,
        selfExcludedUntil: null
      }
    });

    await expect(debitStakes('player-a', 'player-b', 5000n, 'AMATEUR'))
      .rejects.toThrow(StakeLimitExceededError);

    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
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