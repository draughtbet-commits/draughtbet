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
  match: { create, findFirst: matchFindFirst },
  matchChallenge: { findFirst: matchChallengeFindFirst, updateMany: jest.fn() },
  matchParticipant: { create: jest.fn() },
  match_update: jest.fn(),
  user: { findUnique: userFindUnique },
  gameOutbox: { create: jest.fn() }
};

const mockPrisma = {
  $transaction: async (cb) => cb(mockTx)
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

const { createOpenMatch, createChallengeMatch, fundOpenMatch, InsufficientFundsError } =
  await import('../lifecycleService.js');

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
