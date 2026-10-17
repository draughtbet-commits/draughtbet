import { jest } from '@jest/globals';

process.env.DATABASE_URL = '';
process.env.REDIS_URL = '';
process.env.NODE_ENV = 'test';
process.env.ADMIN_CORS_ORIGIN = 'http://localhost';

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    findMany: jest.fn()
  },
  platformSettings: {
    findUnique: jest.fn(),
    findUniqueOrThrow: jest.fn()
  },
  wallet: {
    findUnique: jest.fn()
  },
  matchChallenge: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn()
  },
  match: {
    findFirst: jest.fn()
  },
  gameOutbox: {
    findUnique: jest.fn()
  },
  idempotencyRecord: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    deleteMany: jest.fn()
  }
};
jest.unstable_mockModule('../../../utils/db.js', () => ({
  default: mockPrisma
}));

jest.unstable_mockModule('../../../middleware/auth.js', () => ({
  requireAuth: (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    req.user = { id: 'user-1', email: 'user@test.com', tier: 'AMATEUR', isBanned: false };
    next();
  }
}));

jest.unstable_mockModule('../../../utils/redis.js', () => ({
  default: {},
  isRedisReady: jest.fn().mockReturnValue(true)
}));

// The engine services stay out of these route tests; only the controller
// guards, request handling and response shapes are exercised here.
const namedError = (name) =>
  class extends Error {
    constructor(message) {
      super(message);
      this.name = name;
    }
  };

// The controller's copy of the lifecycle mock is selected by jest's module mock
// registry, so per-request outcomes are steered through a shared behavior object
// the factory reads rather than through the test-side mock binding.
const lifecycleJoin = { calls: [], fundError: null };

jest.unstable_mockModule('../../../modules/v2/lifecycleService.js', () => ({
  MatchNotFoundError: namedError('MatchNotFoundError'),
  NotParticipantError: namedError('NotParticipantError'),
  MatchNotReadyError: namedError('MatchNotReadyError'),
  ActiveMatchError: namedError('ActiveMatchError'),
  JoinUnavailableError: namedError('JoinUnavailableError'),
  TierMismatchError: namedError('TierMismatchError'),
  createOpenMatch: jest.fn(),
  createChallengeMatch: jest.fn(),
  fundOpenMatch: jest.fn((...args) => {
    lifecycleJoin.calls.push(args);
    return Promise.reject(lifecycleJoin.fundError);
  }),
  listOpenMatches: jest.fn(),
  listActiveMatches: jest.fn(),
  buildLifecycleSnapshot: jest.fn(),
  markReady: jest.fn(),
  matchesJoinedOpenStatuses: jest.fn()
}));

jest.unstable_mockModule('../../../services/gameActivationService.js', () => ({
  finalizeMatchActivation: jest.fn(),
  cancelPreplayMatch: jest.fn(),
  MatchNotCancellableError: namedError('MatchNotCancellableError')
}));

const notification = { create: jest.fn() };
jest.unstable_mockModule('../../../modules/notification/service.js', () => ({
  NotificationService: notification
}));

const logger = (await import('../../../utils/logger.js')).default;
jest.spyOn(logger, 'info').mockImplementation(() => {});
jest.spyOn(logger, 'warn').mockImplementation(() => {});
jest.spyOn(logger, 'error').mockImplementation(() => {});

const { default: app } = await import('../../../app.js');
const { default: request } = await import('supertest');
const lifecycle = await import('../../../modules/v2/lifecycleService.js');
const activation = await import('../../../services/gameActivationService.js');

const authHeaders = {
  Authorization: 'Bearer token',
  'Idempotency-Key': 'challenge-create-0001'
};

const challengePayload = (overrides = {}) => ({
  stakeMinor: 100000,
  timeControlSeconds: 600,
  ruleset: 'CLASSIC',
  ...overrides
});

const settingsRow = () => ({ id: 'singleton', commissionPercent: 10 });

const targetRow = (overrides = {}) => ({
  id: 'player-2',
  tier: 'AMATEUR',
  isBanned: false,
  ...overrides
});

describe('Player challenge surface', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    lifecycleJoin.calls.length = 0;
    lifecycleJoin.fundError = new lifecycle.ActiveMatchError('You already have an active match');
    mockPrisma.idempotencyRecord.findUnique.mockResolvedValue(null);
    mockPrisma.idempotencyRecord.create.mockResolvedValue({});
    mockPrisma.idempotencyRecord.update.mockResolvedValue({});
    mockPrisma.idempotencyRecord.deleteMany.mockResolvedValue({});
    mockPrisma.platformSettings.findUniqueOrThrow.mockResolvedValue(settingsRow());
    mockPrisma.platformSettings.findUnique.mockResolvedValue(settingsRow());
    mockPrisma.wallet.findUnique.mockResolvedValue({ currency: 'NGN' });
  });

  describe('POST /api/v1/players/:id/challenge', () => {
    // The stake middleware and the route fetch the acting user; the route
    // fetches the target separately, so arrange per-id.
    const seedUsers = (target) => {
      mockPrisma.user.findUnique.mockImplementation(({ where }) => {
        if (where.id === 'user-1') {
          return Promise.resolve({ id: 'user-1', tier: 'AMATEUR', username: 'seed_home' });
        }
        return Promise.resolve(target);
      });
    };

    it('requires authentication', async () => {
      const res = await request(app)
        .post('/api/v1/players/player-2/challenge')
        .send(challengePayload());
      expect(res.status).toBe(401);
    });

    it('refuses challenging yourself', async () => {
      seedUsers(targetRow());
      const res = await request(app)
        .post('/api/v1/players/user-1/challenge')
        .set(authHeaders)
        .send(challengePayload());
      expect(res.status).toBe(400);
      expect(lifecycle.createChallengeMatch).not.toHaveBeenCalled();
    });

    it('requires a positive integer time control', async () => {
      seedUsers(targetRow());
      const res = await request(app)
        .post('/api/v1/players/player-2/challenge')
        .set(authHeaders)
        .send(challengePayload({ timeControlSeconds: 0 }));
      expect(res.status).toBe(400);
      expect(lifecycle.createChallengeMatch).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown or banned target', async () => {
      seedUsers(null);
      const res = await request(app)
        .post('/api/v1/players/gone/challenge')
        .set(authHeaders)
        .send(challengePayload());
      expect(res.status).toBe(404);
      expect(lifecycle.createChallengeMatch).not.toHaveBeenCalled();
    });

    it('refuses a cross-tier challenge', async () => {
      seedUsers(targetRow({ tier: 'PRO' }));
      const res = await request(app)
        .post('/api/v1/players/player-2/challenge')
        .set(authHeaders)
        .send(challengePayload());
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/tier/i);
      expect(lifecycle.createChallengeMatch).not.toHaveBeenCalled();
    });

    it('refuses while the inviter or target already holds a pre-terminal match', async () => {
      seedUsers(targetRow());
      lifecycle.matchesJoinedOpenStatuses.mockResolvedValueOnce({ id: 'other-match' });
      const res = await request(app)
        .post('/api/v1/players/player-2/challenge')
        .set(authHeaders)
        .send(challengePayload());
      expect(res.status).toBe(409);
      expect(lifecycle.createChallengeMatch).not.toHaveBeenCalled();
    });

    it('refuses a duplicate pending challenge in either direction', async () => {
      seedUsers(targetRow());
      lifecycle.matchesJoinedOpenStatuses.mockResolvedValue(null);
      mockPrisma.matchChallenge.findFirst.mockResolvedValue({ id: 'c1' });
      const res = await request(app)
        .post('/api/v1/players/player-2/challenge')
        .set(authHeaders)
        .send(challengePayload());
      expect(res.status).toBe(409);
      expect(mockPrisma.matchChallenge.findFirst).toHaveBeenCalledWith({
        where: {
          status: 'PENDING',
          OR: [
            { inviterId: 'user-1', inviteeId: 'player-2' },
            { inviterId: 'player-2', inviteeId: 'user-1' }
          ]
        },
        select: { id: true }
      });
      expect(lifecycle.createChallengeMatch).not.toHaveBeenCalled();
    });

    it('returns 402 when the challenger cannot afford the stake', async () => {
      seedUsers(targetRow());
      lifecycle.matchesJoinedOpenStatuses.mockResolvedValue(null);
      mockPrisma.matchChallenge.findFirst.mockResolvedValue(null);
      const fundsError = new Error('Insufficient funds to create this challenge');
      fundsError.name = 'InsufficientFundsError';
      lifecycle.createChallengeMatch.mockRejectedValueOnce(fundsError);

      const res = await request(app)
        .post('/api/v1/players/player-2/challenge')
        .set(authHeaders)
        .send(challengePayload());

      expect(res.status).toBe(402);
      expect(res.body.error).toMatch(/insufficient funds/i);
      expect(notification.create).not.toHaveBeenCalled();
    });

    it('creates a challenge match and returns its id', async () => {
      seedUsers(targetRow());
      lifecycle.matchesJoinedOpenStatuses.mockResolvedValue(null);
      mockPrisma.matchChallenge.findFirst.mockResolvedValue(null);
      lifecycle.createChallengeMatch.mockResolvedValue({ id: 'match-1' });

      const res = await request(app)
        .post('/api/v1/players/player-2/challenge')
        .set(authHeaders)
        .send(challengePayload());

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ data: { id: 'match-1' } });
      expect(lifecycle.createChallengeMatch).toHaveBeenCalledWith({
        creatorId: 'user-1',
        inviteeId: 'player-2',
        tier: 'AMATEUR',
        stakeMinorUnits: 100000,
        timeControlSeconds: 600,
        commissionPercent: 10,
        currency: 'NGN'
      });
      expect(mockPrisma.matchChallenge.findFirst).toHaveBeenCalled();
      expect(notification.create).toHaveBeenCalledWith(
        'player-2',
        'MATCH_CHALLENGE',
        'New Challenge',
        expect.stringContaining('challenged you to a match'),
        '/play/challenge',
        'match-1'
      );
    });
  });

  describe('GET /api/v1/players/challenges', () => {
    it('lists pending invites with a public opponent brief', async () => {
      mockPrisma.matchChallenge.findMany.mockResolvedValue([
        {
          id: 'c-received',
          matchId: 'match-1',
          inviterId: 'player-2',
          inviteeId: 'user-1',
          stakeMinorUnits: BigInt(200000),
          status: 'PENDING',
          createdAt: new Date('2026-09-25T10:00:00Z')
        },
        {
          id: 'c-sent',
          matchId: 'match-2',
          inviterId: 'user-1',
          inviteeId: 'player-3',
          stakeMinorUnits: BigInt(100000),
          status: 'PENDING',
          createdAt: new Date('2026-09-25T11:00:00Z')
        }
      ]);
      mockPrisma.user.findMany.mockResolvedValue([
        { id: 'player-2', username: 'rival', displayName: null, avatar: 'avatar_02', tier: 'AMATEUR' },
        { id: 'player-3', username: 'fresh', displayName: 'Fresh Face', avatar: 'avatar_01', tier: 'AMATEUR' }
      ]);

      const res = await request(app)
        .get('/api/v1/players/challenges')
        .set('Authorization', 'Bearer token');

      expect(res.status).toBe(200);
      expect(res.body.data.challenges).toEqual([
        {
          id: 'c-received',
          matchId: 'match-1',
          direction: 'received',
          status: 'PENDING',
          stakeMinorUnits: 200000,
          timeControlSeconds: null,
          ruleset: 'CLASSIC',
          createdAt: '2026-09-25T10:00:00.000Z',
          opponent: {
            id: 'player-2',
            username: 'rival',
            displayName: null,
            avatarId: 'avatar_02',
            tier: 'AMATEUR'
          }
        },
        {
          id: 'c-sent',
          matchId: 'match-2',
          direction: 'sent',
          status: 'PENDING',
          stakeMinorUnits: 100000,
          timeControlSeconds: null,
          ruleset: 'CLASSIC',
          createdAt: '2026-09-25T11:00:00.000Z',
          opponent: {
            id: 'player-3',
            username: 'fresh',
            displayName: 'Fresh Face',
            avatarId: 'avatar_01',
            tier: 'AMATEUR'
          }
        }
      ]);
      // Contact / legal-name details never reach the list.
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain('email');
      expect(raw).not.toContain('fullName');
    });
  });

  describe('POST /api/v1/matches/:id/decline', () => {
    it('requires authentication', async () => {
      const res = await request(app).post('/api/v1/matches/match-1/decline');
      expect(res.status).toBe(401);
    });

    it('returns 404 for a match without a challenge', async () => {
      mockPrisma.matchChallenge.findFirst.mockResolvedValue(null);
      const res = await request(app)
        .post('/api/v1/matches/match-1/decline')
        .set(authHeaders);
      expect(res.status).toBe(404);
      expect(activation.cancelPreplayMatch).not.toHaveBeenCalled();
    });

    it('rejects a non-invitee', async () => {
      mockPrisma.matchChallenge.findFirst.mockResolvedValue({
        id: 'c1',
        inviterId: 'player-2',
        inviteeId: 'player-3',
        status: 'PENDING'
      });
      const res = await request(app)
        .post('/api/v1/matches/match-1/decline')
        .set(authHeaders);
      expect(res.status).toBe(403);
      expect(activation.cancelPreplayMatch).not.toHaveBeenCalled();
    });

    it('refuses a declined challenge a second time', async () => {
      mockPrisma.matchChallenge.findFirst.mockResolvedValue({
        id: 'c1',
        inviterId: 'player-2',
        inviteeId: 'user-1',
        status: 'DECLINED'
      });
      const res = await request(app)
        .post('/api/v1/matches/match-1/decline')
        .set(authHeaders);
      expect(res.status).toBe(409);
    });

    it('declines as the invitee, cancels the match and marks the challenge', async () => {
      mockPrisma.matchChallenge.findFirst.mockResolvedValue({
        id: 'c1',
        inviterId: 'player-2',
        inviteeId: 'user-1',
        status: 'PENDING'
      });
      activation.cancelPreplayMatch.mockResolvedValue({
        matchId: 'match-1',
        status: 'CANCELLED',
        refunded: false
      });
      mockPrisma.matchChallenge.update.mockResolvedValue({});
      mockPrisma.user.findUnique.mockResolvedValue({
        username: 'rival',
        displayName: null
      });

      const res = await request(app)
        .post('/api/v1/matches/match-1/decline')
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        data: { id: 'match-1', status: 'CANCELLED', declined: true }
      });
      expect(activation.cancelPreplayMatch).toHaveBeenCalledWith('match-1');
      expect(mockPrisma.matchChallenge.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { status: 'DECLINED' }
      });
      // The decline names the invitee, not the inviter — the inviter gets told
      // which player turned them down.
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        select: { username: true, displayName: true }
      });
      expect(notification.create).toHaveBeenCalledWith(
        'player-2',
        'MATCH_CHALLENGE_DECLINED',
        'Challenge declined',
        'rival declined your challenge',
        null,
        'match-1'
      );
    });
  });

  describe('POST /api/v1/matches/:id/join', () => {
    it('returns 409 when the joiner already holds an active match', async () => {
      lifecycleJoin.fundError = new lifecycle.ActiveMatchError('You already have an active match');

      const res = await request(app)
        .post('/api/v1/matches/match-1/join')
        .set(authHeaders);

      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: 'You already have an active match'
      });
      expect(lifecycleJoin.calls).toEqual([
        ['user-1', 'match-1', { tier: 'AMATEUR' }]
      ]);
      expect(activation.finalizeMatchActivation).not.toHaveBeenCalled();
    });

    it('returns 404 when the target match does not exist', async () => {
      lifecycleJoin.fundError = new lifecycle.MatchNotFoundError('Match not found');

      const res = await request(app)
        .post('/api/v1/matches/match-missing/join')
        .set({ ...authHeaders, 'Idempotency-Key': 'match-join-0002' });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Match not found' });
    });
  });
});