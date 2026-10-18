import { jest } from '@jest/globals';

// A broke player must not be able to post an OPEN listing: the opponent who
// joins then funds both sides atomically, so an unfundable listing only
// surfaces "insufficient funds" to the wrong wallet at join time.

const create = jest.fn();
const matchFindFirst = jest.fn();
const matchChallengeFindFirst = jest.fn();
const userFindUnique = jest.fn();
const queryRaw = jest.fn();

const mockTx = {
  $queryRaw: queryRaw,
  match: { create, findFirst: matchFindFirst, update: jest.fn() },
  matchChallenge: { findFirst: matchChallengeFindFirst, updateMany: jest.fn() },
  matchParticipant: { create: jest.fn() },
  match_update: jest.fn(),
  user: { findUnique: userFindUnique },
  gameOutbox: { create: jest.fn() }
};

const mockPrisma = {
  $transaction: async (cb) => cb(mockTx),
  match: { findUnique: jest.fn(), findMany: jest.fn() },
  user: { findUnique: jest.fn() }
};

jest.unstable_mockModule('../../../utils/db.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.unstable_mockModule('../../../utils/redis.js', () => ({
  default: { hset: jest.fn() }
}));
jest.unstable_mockModule('../../../sockets/gameManager.js', () => ({
  initializeGame: jest.fn(),
  getGameState: jest.fn(),
  startMatchGame: jest.fn()
}));
jest.unstable_mockModule('../../../sockets/gameProtocol.js', () => ({
  buildStatePayload: jest.fn(() => ({}))
}));
jest.unstable_mockModule('../../../sockets/index.js', () => ({
  getIO: jest.fn(() => ({ to: () => ({ emit: jest.fn() }) }))
}));
jest.unstable_mockModule('../../../services/eligibilityService.js', () => ({
  assertEligibleForMoney: jest.fn(async () => undefined)
}));

const lockWalletForUpdate = jest.fn();
const lockWalletsInOrder = jest.fn();
jest.unstable_mockModule('../../../services/matchService.js', () => ({
  lockWalletForUpdate,
  lockWalletsInOrder,
  ActiveMatchError: class ActiveMatchError extends Error {}
}));

const getLedgerAvailable = jest.fn();
jest.unstable_mockModule('../../../services/ledgerService.js', () => ({
  getLedgerAvailable
}));

jest.unstable_mockModule('../../../modules/stake/service.js', () => ({
  reserveBothStakes: jest.fn()
}));

const transitionMatch = jest.fn();
jest.unstable_mockModule('../../../modules/match/service.js', () => ({
  MatchNotFoundError: class MatchNotFoundError extends Error {},
  NotParticipantError: class NotParticipantError extends Error {},
  MatchNotReadyError: class MatchNotReadyError extends Error {},
  transitionMatch
}));

const {
  createOpenMatch,
  createChallengeMatch,
  fundOpenMatch,
  resolvePrivateListingId,
  listOpenMatches,
  openMatchListing,
  InsufficientFundsError,
  JoinUnavailableError
} = await import('../lifecycleService.js');

const OPEN_MATCH = {
  id: 'm-1',
  status: 'OPEN',
  playerLightId: 'challenger',
  playerDarkId: '',
  tier: 'MASTER',
  stakeMinorUnits: 100000n,
  createdAt: new Date()
};

describe('open-match funding guards', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    lockWalletForUpdate.mockResolvedValue({ currency: 'NGN' });
    lockWalletsInOrder.mockResolvedValue([
      { currency: 'NGN' },
      { currency: 'NGN' }
    ]);
    queryRaw.mockResolvedValue([OPEN_MATCH]);
    matchFindFirst.mockResolvedValue(null);
    matchChallengeFindFirst.mockResolvedValue(null);
    userFindUnique.mockImplementation(async ({ where }) =>
      where.id === 'challenger'
        ? { id: 'challenger', tier: 'MASTER', isBanned: false }
        : { id: 'joiner', tier: 'MASTER', isBanned: false }
    );
    transitionMatch.mockResolvedValue({ id: 'm-1', status: 'EXPIRED' });
  });

  describe('creating a listing', () => {
    it('refuses to create an open match the creator cannot fund', async () => {
      getLedgerAvailable.mockResolvedValue(99999n);

      await expect(
        createOpenMatch({
          creatorId: 'u1',
          tier: 'MASTER',
          stakeMinorUnits: 100000,
          timeControlSeconds: 600,
          commissionPercent: 10
        })
      ).rejects.toBeInstanceOf(InsufficientFundsError);

      expect(create).not.toHaveBeenCalled();
    });

    it('creates the listing when the creator can cover the stake', async () => {
      getLedgerAvailable.mockResolvedValue(100000n);
      create.mockResolvedValue({ id: 'new-match' });

      const match = await createOpenMatch({
        creatorId: 'u1',
        tier: 'MASTER',
        stakeMinorUnits: 100000,
        timeControlSeconds: 600,
        commissionPercent: 10
      });

      expect(match).toEqual({ id: 'new-match' });
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('generates a shareable code and stores PRIVATE visibility', async () => {
      getLedgerAvailable.mockResolvedValue(100000n);
      create.mockResolvedValue({ id: 'm-priv' });

      await createOpenMatch({
        creatorId: 'u1',
        tier: 'MASTER',
        stakeMinorUnits: 100000,
        timeControlSeconds: 600,
        commissionPercent: 10,
        visibility: 'PRIVATE'
      });

      const { data } = create.mock.calls[0][0];
      expect(data.visibility).toBe('PRIVATE');
      expect(data.roomCode).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    });

    it('leaves a public listing without a room code', async () => {
      getLedgerAvailable.mockResolvedValue(100000n);
      create.mockResolvedValue({ id: 'm-pub' });

      await createOpenMatch({
        creatorId: 'u1',
        tier: 'MASTER',
        stakeMinorUnits: 100000,
        timeControlSeconds: 600,
        commissionPercent: 10
      });

      const { data } = create.mock.calls[0][0];
      expect(data.visibility).toBe('PUBLIC');
      expect(data.roomCode).toBeNull();
    });

    it('regenerates the code on a unique collision instead of failing', async () => {
      getLedgerAvailable.mockResolvedValue(100000n);
      create
        .mockRejectedValueOnce(
          Object.assign(new Error('unique'), {
            code: 'P2002',
            meta: { target: ['roomCode'] }
          })
        )
        .mockResolvedValueOnce({ id: 'm-priv' });

      const match = await createOpenMatch({
        creatorId: 'u1',
        tier: 'MASTER',
        stakeMinorUnits: 100000,
        timeControlSeconds: 600,
        commissionPercent: 10,
        visibility: 'PRIVATE'
      });

      expect(match).toEqual({ id: 'm-priv' });
      expect(create).toHaveBeenCalledTimes(2);
      for (const call of create.mock.calls) {
        expect(call[0].data.roomCode).toMatch(
          /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/
        );
      }
    });

    it('refuses to create a directed challenge the challenger cannot fund', async () => {
      getLedgerAvailable.mockResolvedValue(0n);

      await expect(
        createChallengeMatch({
          creatorId: 'u1',
          inviteeId: 'u2',
          tier: 'MASTER',
          stakeMinorUnits: 100000,
          timeControlSeconds: 600,
          commissionPercent: 10
        })
      ).rejects.toBeInstanceOf(InsufficientFundsError);

      expect(create).not.toHaveBeenCalled();
    });
  });

  describe('joining an open match', () => {
    it('blames the joiner when only the joiner is short', async () => {
      getLedgerAvailable
        .mockResolvedValueOnce(100000n) // challenger (light) can afford
        .mockResolvedValueOnce(99999n); // joiner (dark) cannot

      await expect(fundOpenMatch('joiner', 'm-1', { tier: 'MASTER' })).rejects.toThrow(
        'Insufficient funds for stake'
      );
      // A still-fundable listing is left untouched.
      expect(transitionMatch).not.toHaveBeenCalled();
    });

    it('blames the creator and retires the listing when only the creator is short', async () => {
      getLedgerAvailable
        .mockResolvedValueOnce(0n) // challenger (light) cannot afford
        .mockResolvedValueOnce(100000n); // joiner (dark) can

      await expect(fundOpenMatch('joiner', 'm-1', { tier: 'MASTER' })).rejects.toThrow(
        /creator no longer has funds/
      );
      // The unfundable listing is expired so other joiners are not misled.
      expect(transitionMatch).toHaveBeenCalledWith(mockTx, 'm-1', 'EXPIRED');
      expect(mockTx.matchChallenge.updateMany).toHaveBeenCalled();
    });
  });
});

describe('private room codes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    lockWalletForUpdate.mockResolvedValue({ currency: 'NGN' });
    lockWalletsInOrder.mockResolvedValue([
      { currency: 'NGN' },
      { currency: 'NGN' }
    ]);
    queryRaw.mockResolvedValue([{ ...OPEN_MATCH, visibility: 'PRIVATE' }]);
    matchFindFirst.mockResolvedValue(null);
    matchChallengeFindFirst.mockResolvedValue(null);
    userFindUnique.mockImplementation(async ({ where }) =>
      where.id === 'challenger'
        ? { id: 'challenger', tier: 'MASTER', isBanned: false }
        : { id: 'joiner', tier: 'MASTER', isBanned: false }
    );
    mockPrisma.match.findUnique.mockResolvedValue({
      id: 'm-1',
      visibility: 'PRIVATE'
    });
  });

  it('normalizes a typed code before resolving it', async () => {
    await expect(resolvePrivateListingId('db-2 415')).resolves.toBe('m-1');
    expect(mockPrisma.match.findUnique).toHaveBeenCalledWith({
      where: { roomCode: 'DB2415' },
      select: { id: true, visibility: true }
    });
  });

  it('rejects a code that is not a private room', async () => {
    mockPrisma.match.findUnique.mockResolvedValue({
      id: 'm-1',
      visibility: 'PUBLIC'
    });
    await expect(resolvePrivateListingId('ABCDEF')).rejects.toMatchObject({
      name: 'RoomCodeNotFoundError'
    });
  });

  it('rejects a malformed code without hitting the database', async () => {
    await expect(resolvePrivateListingId('nope')).rejects.toMatchObject({
      name: 'RoomCodeNotFoundError'
    });
    expect(mockPrisma.match.findUnique).not.toHaveBeenCalled();
  });

  it('refuses an id join to a private listing without the code', async () => {
    await expect(
      fundOpenMatch('joiner', 'm-1', { tier: 'MASTER' })
    ).rejects.toBeInstanceOf(JoinUnavailableError);
  });

  it('lets the code path fund the same private listing', async () => {
    getLedgerAvailable.mockResolvedValue(100000n);
    await expect(
      fundOpenMatch('joiner', 'm-1', { tier: 'MASTER', viaCode: true })
    ).resolves.toBeTruthy();
  });

  it('hides private listings from the public arena query', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ tier: 'MASTER' });
    mockPrisma.match.findMany.mockResolvedValue([]);

    await listOpenMatches('viewer-1');

    expect(mockPrisma.match.findMany.mock.calls[0][0].where.visibility).toEqual({
      not: 'PRIVATE'
    });
  });
});

describe('open-match listing host stats', () => {
  // A joiner decides who to play from the listing, so the host's rating and win
  // rate must ride along with it (same convention as the player directory).
  const baseMatch = {
    id: 'm-9',
    stakeMinorUnits: 100000n,
    timeControlSeconds: 600,
    createdAt: new Date(),
    playerLightId: 'host-1',
    tier: 'MASTER',
    participants: [
      {
        side: 'LIGHT',
        user: {
          id: 'host-1',
          username: 'Host',
          displayName: 'Host',
          avatar: 'avatar_02',
          tier: 'MASTER',
          playerStats: { rating: 1780, wins: 6, losses: 3, draws: 1 }
        }
      }
    ]
  };

  it('exposes the host rating and a rounded win rate over decided games', () => {
    const listing = openMatchListing(baseMatch);
    expect(listing.creator.rating).toBe(1780);
    expect(listing.creator.winRate).toBe(60);
  });

  it('reports a null win rate before any decided games', () => {
    const listing = openMatchListing({
      ...baseMatch,
      participants: [
        {
          side: 'LIGHT',
          user: { id: 'host-1', username: 'Host', playerStats: { rating: 1200, wins: 0, losses: 0, draws: 0 } }
        }
      ]
    });
    expect(listing.creator.rating).toBe(1200);
    expect(listing.creator.winRate).toBeNull();
  });

  it('leaves rating and win rate null when the host has no stats row', () => {
    const listing = openMatchListing({
      ...baseMatch,
      participants: [{ side: 'LIGHT', user: { id: 'host-1', username: 'Host', tier: 'MASTER' } }]
    });
    expect(listing.creator.rating).toBeNull();
    expect(listing.creator.winRate).toBeNull();
  });

  it('reflects visibility and carries the code for a private room', () => {
    expect(openMatchListing({ ...baseMatch, visibility: 'PUBLIC' }).visibility).toBe(
      'PUBLIC'
    );
    const priv = openMatchListing({
      ...baseMatch,
      visibility: 'PRIVATE',
      roomCode: 'ABC234'
    });
    expect(priv.visibility).toBe('PRIVATE');
    expect(priv.roomCode).toBe('ABC234');
  });
});
