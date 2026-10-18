import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// The legacy GET /history surface must survive the production mount order from
// src/app.js (openMatchRouter before matchRouter). openMatchRouter's catch-all
// GET /:id would otherwise swallow /history and answer with a 404 lifecycle
// snapshot instead of the sanitized match list. The older contract tests mount
// only matchRouter, so they surface the success path but cannot see the param
// route shadowing — hence this test against the real mount order.

const mockPrisma = {
  $transaction: async (cb) => cb(mockPrisma),
  match: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    findMany: jest.fn()
  },
  matchChallenge: { update: jest.fn(), updateMany: jest.fn() },
  gameOutbox: { updateMany: jest.fn() },
  stakeReservation: { findMany: jest.fn(), updateMany: jest.fn() },
  user: { findMany: jest.fn() }
};

const emit = jest.fn();
const to = jest.fn(() => ({ emit }));
const mockIO = { to };

jest.unstable_mockModule('../../../utils/db.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.unstable_mockModule('../../../sockets/index.js', () => ({ getIO: jest.fn(() => mockIO) }));
jest.unstable_mockModule('../../../utils/redis.js', () => ({
  default: { del: jest.fn(async () => 1) }
}));
jest.unstable_mockModule('../../../middleware/auth.js', () => ({
  requireAuth: (req, res, next) => {
    req.user = { id: 'light-1', email: 'light@example.com' };
    next();
  }
}));
jest.unstable_mockModule('../../../middleware/idempotency.js', () => ({
  requireIdempotencyKey: () => (req, res, next) => next()
}));
jest.unstable_mockModule('../../../sockets/gameManager.js', () => ({
  initializeGame: jest.fn(),
  getGameState: jest.fn(),
  reconstructMoveHistory: jest.fn(),
  startMatchGame: jest.fn()
}));
jest.unstable_mockModule('../../../sockets/gameProtocol.js', () => ({
  buildStatePayload: jest.fn(() => ({}))
}));
jest.unstable_mockModule('../../../services/eligibilityService.js', () => ({
  assertEligibleForMoney: jest.fn(async () => undefined)
}));
jest.unstable_mockModule('../../../services/matchService.js', () => ({
  lockWalletsInOrder: jest.fn(async () => []),
  lockWalletForUpdate: jest.fn(async () => ({})),
  ActiveMatchError: class ActiveMatchError extends Error {}
}));
jest.unstable_mockModule('../../../modules/stake/service.js', () => ({
  releaseStakes: jest.fn(async () => undefined),
  reserveBothStakes: jest.fn(async () => undefined)
}));
jest.unstable_mockModule('../../../services/gameActivationService.js', () => ({
  cancelPreplayMatch: jest.fn(),
  finalizeMatchActivation: jest.fn(),
  MatchNotCancellableError: class MatchNotCancellableError extends Error {}
}));
jest.unstable_mockModule('../lifecycleService.js', () => ({
  createOpenMatch: jest.fn(),
  fundOpenMatch: jest.fn(),
  resolvePrivateListingId: jest.fn(),
  listOpenMatches: jest.fn(),
  listActiveMatches: jest.fn(),
  markReady: jest.fn(),
  buildLifecycleSnapshot: jest.fn(async () => ({ matchId: 'm-1', status: 'RELEASED' })),
  MatchNotFoundError: class MatchNotFoundError extends Error {},
  NotParticipantError: class NotParticipantError extends Error {},
  MatchNotReadyError: class MatchNotReadyError extends Error {},
  JoinUnavailableError: class JoinUnavailableError extends Error {}
}));
jest.unstable_mockModule('../../../modules/notification/service.js', () => ({
  NotificationService: { create: jest.fn(async () => undefined) }
}));
jest.unstable_mockModule('../../../modules/eligibility/service.js', () => ({
  EligibilityService: class {
    assertCanPlay = jest.fn(async () => undefined);
  }
}));

const { buildLifecycleSnapshot } = await import('../lifecycleService.js');
const { openMatchRouter } = await import('../openMatchesController.js');
const { matchRouter } = await import('../../match/controller.js');
const { default: express } = await import('express');
const { default: request } = await import('supertest');

// Mirrors src/app.js: `app.use('/api/v1/matches', matchRateLimiter,
// openMatchRouter, matchRouter, disputeUserRouter)`. disputeUserRouter adds no
// GET routes, so it is irrelevant to this surface.
const app = express();
app.use(express.json());
app.use('/api/v1/matches', openMatchRouter, matchRouter);

describe('legacy GET /matches/history behind the production mount order', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.match.findMany.mockResolvedValue([
      {
        id: 'm-1',
        playerLightId: 'light-1',
        playerDarkId: 'dark-1',
        tier: 'PRO',
        stakeMinorUnits: 100000n,
        status: 'COMPLETED',
        winnerId: 'light-1',
        endReason: 'NO_LEGAL_MOVES',
        createdAt: new Date(),
        endedAt: new Date()
      }
    ]);
    mockPrisma.user.findMany.mockResolvedValue([
      { id: 'light-1', username: 'light_handle' },
      { id: 'dark-1', username: 'dark_handle' }
    ]);
    buildLifecycleSnapshot.mockResolvedValue({ matchId: 'm-1', status: 'RELEASED' });
  });

  it('is served by the legacy match router, not the v2 lifecycle snapshot', async () => {
    const res = await request(app).get('/api/v1/matches/history');

    expect(res.status).toBe(200);
    expect(res.body.matches).toHaveLength(1);
    expect(res.body.matches[0].playerLight).toEqual({ id: 'light-1', username: 'light_handle' });
    expect(res.body.matches[0].playerDark).toEqual({ id: 'dark-1', username: 'dark_handle' });
    expect(res.body.matches[0].stakeMinorUnits).toBe('100000');

    // The legacy handler served it. If GET /:id swallowed /history, findMany
    // would never run and buildLifecycleSnapshot would be called instead.
    expect(mockPrisma.match.findMany).toHaveBeenCalled();
    expect(buildLifecycleSnapshot).not.toHaveBeenCalled();

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('@example.com');
  });

  it('still answers literal v2 ids through the lifecycle snapshot', async () => {
    const res = await request(app).get('/api/v1/matches/m-1');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ matchId: 'm-1', status: 'RELEASED' });
    expect(buildLifecycleSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      'm-1',
      'light-1'
    );
  });
});