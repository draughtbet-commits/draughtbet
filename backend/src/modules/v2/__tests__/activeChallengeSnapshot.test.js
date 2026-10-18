import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// A directed challenge seats only the inviter (playerDarkId is the empty
// placeholder) until the invitee joins. The lifecycle snapshot must therefore
// (a) let the invitee read it and (b) expose the challenge direction so the app
// can render "challenge sent" / "incoming challenge" and the accept/cancel
// actions instead of the generic "waiting for an opponent stake" dead end.

class NotParticipantError extends Error {
  constructor(message = 'Not a participant') {
    super(message);
    this.name = 'NotParticipantError';
  }
}
class MatchNotFoundError extends Error {
  constructor(message = 'Match not found') {
    super(message);
    this.name = 'MatchNotFoundError';
  }
}
class MatchNotReadyError extends Error {}
class ActiveMatchError extends Error {}

const mockPrisma = {
  match: { findUnique: jest.fn(), findMany: jest.fn() },
  matchChallenge: { findFirst: jest.fn(), findMany: jest.fn() },
  platformSettings: { findUnique: jest.fn() },
  user: { findUnique: jest.fn() },
  stakeReservation: { findMany: jest.fn() }
};

jest.unstable_mockModule('../../../utils/db.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.unstable_mockModule('../../../utils/redis.js', () => ({ default: {} }));
jest.unstable_mockModule('../../../sockets/gameManager.js', () => ({
  initializeGame: jest.fn(),
  getGameState: jest.fn(async () => null),
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
jest.unstable_mockModule('../../../services/matchService.js', () => ({
  lockWalletsInOrder: jest.fn(async () => []),
  lockWalletForUpdate: jest.fn(async () => ({})),
  ActiveMatchError
}));
jest.unstable_mockModule('../../../modules/stake/service.js', () => ({
  reserveBothStakes: jest.fn(),
  releaseStakes: jest.fn()
}));
jest.unstable_mockModule('../../../modules/match/service.js', () => ({
  transitionMatch: jest.fn(),
  MatchNotFoundError,
  NotParticipantError,
  MatchNotReadyError
}));

const { buildLifecycleSnapshot, listActiveMatches } = await import(
  '../lifecycleService.js'
);

const INVITER = 'inviter-1';
const INVITEE = 'invitee-1';

const match = (overrides = {}) => ({
  id: 'm-1',
  status: 'OPEN',
  playerLightId: 'inviter-1',
  playerDarkId: '',
  stakeMinorUnits: 100000n,
  settlementCommissionPercent: 5,
  endReason: null,
  endedAt: null,
  cancelledAt: null,
  currency: 'NGN',
  timeControlSeconds: 600,
  ...overrides
});

const pendingChallenge = (overrides = {}) => ({
  id: 'c-1',
  inviterId: 'inviter-1',
  inviteeId: 'invitee-1',
  status: 'PENDING',
  createdAt: new Date(),
  ...overrides
});

describe('buildLifecycleSnapshot with a directed challenge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.platformSettings.findUnique.mockResolvedValue({
      commissionPercent: 5
    });
    mockPrisma.stakeReservation.findMany.mockResolvedValue([]);
    mockPrisma.user.findUnique.mockImplementation(async ({ where }) => ({
      id: where.id,
      username: where.id,
      displayName: where.id,
      avatar: 'avatar_01',
      tier: 'AMATEUR'
    }));
  });

  it('exposes the sent direction to the inviter with the invitee as opponent', async () => {
    mockPrisma.match.findUnique.mockResolvedValue({
      id: 'm-1',
      status: 'OPEN',
      playerLightId: 'inviter-1',
      playerDarkId: '',
      stakeMinorUnits: 100000n,
      settlementCommissionPercent: 5,
      endReason: null,
      endedAt: null,
      cancelledAt: null,
      currency: 'NGN',
      timeControlSeconds: 600
    });
    mockPrisma.matchChallenge.findFirst.mockResolvedValue({
      id: 'c-1',
      inviterId: 'inviter-1',
      inviteeId: 'invitee-1',
      status: 'PENDING',
      createdAt: new Date()
    });

    const snapshot = await buildLifecycleSnapshot(
      mockPrisma,
      'm-1',
      'inviter-1'
    );

    expect(snapshot.status).toBe('OPEN');
    expect(snapshot.challenge).toMatchObject({
      id: 'c-1',
      direction: 'SENT',
      status: 'PENDING'
    });
    expect(snapshot.challenge.expiresAt).toBeTruthy();
    expect(snapshot.opponent.id).toBe('invitee-1');
  });

  it('lets the invitee read the pending snapshot even though they are not seated', async () => {
    mockPrisma.match.findUnique.mockResolvedValue({
      id: 'm-1',
      status: 'OPEN',
      playerLightId: 'inviter-1',
      playerDarkId: '',
      stakeMinorUnits: 100000n,
      settlementCommissionPercent: 5,
      endReason: null,
      endedAt: null,
      cancelledAt: null,
      currency: 'NGN',
      timeControlSeconds: 600
    });
    mockPrisma.matchChallenge.findFirst.mockResolvedValue({
      id: 'c-1',
      inviterId: 'inviter-1',
      inviteeId: 'invitee-1',
      status: 'PENDING',
      createdAt: new Date()
    });

    const snapshot = await buildLifecycleSnapshot(
      mockPrisma,
      'm-1',
      'invitee-1'
    );

    expect(snapshot.challenge.direction).toBe('RECEIVED');
    expect(snapshot.opponent.id).toBe('inviter-1');
  });

  it('still rejects an unrelated viewer', async () => {
    mockPrisma.match.findUnique.mockResolvedValue({
      id: 'm-1',
      status: 'OPEN',
      playerLightId: 'inviter-1',
      playerDarkId: '',
      stakeMinorUnits: 100000n,
      settlementCommissionPercent: 5,
      endReason: null,
      endedAt: null,
      cancelledAt: null,
      currency: 'NGN',
      timeControlSeconds: 600
    });
    mockPrisma.matchChallenge.findFirst.mockResolvedValue({
      id: 'c-1',
      inviterId: 'inviter-1',
      inviteeId: 'invitee-1',
      status: 'PENDING',
      createdAt: new Date()
    });

    await expect(
      buildLifecycleSnapshot(mockPrisma, 'm-1', 'stranger-1')
    ).rejects.toBeInstanceOf(NotParticipantError);
  });
});

describe('listActiveMatches', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.platformSettings.findUnique.mockResolvedValue({
      commissionPercent: 5
    });
    mockPrisma.stakeReservation.findMany.mockResolvedValue([]);
    mockPrisma.user.findUnique.mockImplementation(async ({ where }) => ({
      id: where.id,
      username: where.id,
      avatar: 'avatar_01',
      tier: 'AMATEUR'
    }));
  });

  it("includes the invitee's pending challenge alongside their held matches", async () => {
    mockPrisma.match.findMany.mockResolvedValue([{ id: 'held-1' }]);
    mockPrisma.matchChallenge.findMany.mockResolvedValue([
      { matchId: 'invited-1' }
    ]);
    mockPrisma.match.findUnique.mockImplementation(async ({ where }) => ({
      id: where.id,
      status: 'OPEN',
      playerLightId: 'inviter-1',
      playerDarkId: '',
      stakeMinorUnits: 100000n,
      settlementCommissionPercent: 5,
      endReason: null,
      endedAt: null,
      cancelledAt: null,
      currency: 'NGN',
      timeControlSeconds: 600
    }));
    mockPrisma.matchChallenge.findFirst.mockResolvedValue({
      id: 'c-1',
      inviterId: 'inviter-1',
      inviteeId: 'invitee-1',
      status: 'PENDING',
      createdAt: new Date()
    });

    const snapshots = await listActiveMatches('invitee-1');

    const ids = snapshots.map((snapshot) => snapshot.id).sort();
    expect(ids).toEqual(['held-1', 'invited-1']);
    expect(
      snapshots.find((snapshot) => snapshot.id === 'invited-1').challenge
        .direction
    ).toBe('RECEIVED');
  });
});
