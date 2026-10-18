import { jest } from '@jest/globals';

// openMatchRouter is mounted ahead of matchRouter in app.js, so *this* is the
// cancel handler that serves real traffic. The pre-existing contract tests mount
// only matchRouter, whose '/:matchId/cancel' is shadowed and never runs in
// production — which is how the missing release notify went unnoticed.

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
  stakeReservation: { findMany: jest.fn(), updateMany: jest.fn() }
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
  startMatchGame: jest.fn()
}));
jest.unstable_mockModule('../../../sockets/gameProtocol.js', () => ({
  buildStatePayload: jest.fn(() => ({}))
}));
jest.unstable_mockModule('../../../services/eligibilityService.js', () => ({
  assertEligibleForMoney: jest.fn(async () => undefined)
}));
jest.unstable_mockModule('../../../services/matchService.js', () => ({
  lockWalletsInOrder: jest.fn(async () => [
    { id: 'wallet-light', userId: 'light-1' },
    { id: 'wallet-dark', userId: 'dark-1' }
  ]),
  lockWalletForUpdate: jest.fn(async () => ({ id: 'wallet-light', userId: 'light-1' })),
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

const { cancelPreplayMatch } = await import('../../../services/gameActivationService.js');
const { openMatchRouter } = await import('../openMatchesController.js');
const { default: express } = await import('express');
const { default: request } = await import('supertest');

const app = express();
app.use(express.json());
app.use('/api/v1/matches', openMatchRouter);

const FUNDED = {
  id: 'm-1',
  status: 'FUNDED',
  playerLightId: 'light-1',
  playerDarkId: 'dark-1',
  stakeMinorUnits: '5000'
};

describe('POST /matches/:id/cancel (openMatchRouter, the production route)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.match.findFirst.mockResolvedValue({
      id: 'm-1',
      playerLightId: 'light-1',
      playerDarkId: 'dark-1'
    });
    mockPrisma.match.update.mockResolvedValue({ id: 'm-1' });
    mockPrisma.match.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.matchChallenge.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.gameOutbox.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.stakeReservation.findMany.mockResolvedValue([]);
    mockPrisma.match.findMany.mockResolvedValue([]);
    mockPrisma.match.findUnique.mockResolvedValue(FUNDED);
  });

  const emitArgs = () => emit.mock.calls.filter(([ev]) => ev === 'match_preplay_released');

  it('emits match_preplay_released so the opponent is not stranded in the room', async () => {
    cancelPreplayMatch.mockResolvedValue({ matchId: 'm-1', status: 'RELEASED', refunded: true });

    const res = await request(app).post('/api/v1/matches/m-1/cancel');

    expect(res.status).toBe(200);
    // Match room + both user rooms: a player may hold the join without a seat.
    expect(emitArgs()).toHaveLength(3);
    const [, payload] = emitArgs()[0];
    expect(payload).toMatchObject({
      matchId: 'm-1',
      status: 'RELEASED',
      refunded: true,
      cancelledBy: 'light-1'
    });
    // The opponent must be addressed, not just the canceller.
    expect(to).toHaveBeenCalledWith('user:dark-1');
  });

  it('clears the Redis projection and both activeMatch pointers', async () => {
    const { default: redis } = await import('../../../utils/redis.js');
    cancelPreplayMatch.mockResolvedValue({ matchId: 'm-1', status: 'RELEASED', refunded: true });

    await request(app).post('/api/v1/matches/m-1/cancel');

    // A stale activeMatch pointer is what resurrects a cancelled match on the
    // opponent's next cold start via GET /matches/active.
    expect(redis.del).toHaveBeenCalledWith('match:m-1');
    expect(redis.del).toHaveBeenCalledWith('user:light-1:activeMatch');
    expect(redis.del).toHaveBeenCalledWith('user:dark-1:activeMatch');
  });

  it('reports the real status and refunded flag for a DRAFT match', async () => {
    // DRAFT/OPEN is cancelled with no refund; RELEASED would misreport it.
    cancelPreplayMatch.mockResolvedValue({ matchId: 'm-1', status: 'CANCELLED', refunded: false });

    await request(app).post('/api/v1/matches/m-1/cancel');

    const [, payload] = emitArgs()[0];
    expect(payload.status).toBe('CANCELLED');
    expect(payload.refunded).toBe(false);
  });

  it('leaves the stored endReason unchanged', async () => {
    cancelPreplayMatch.mockResolvedValue({ matchId: 'm-1', status: 'RELEASED', refunded: true });

    await request(app).post('/api/v1/matches/m-1/cancel');

    expect(cancelPreplayMatch).toHaveBeenCalledWith('m-1');
  });

  it('does not notify when the caller is not a participant', async () => {
    mockPrisma.match.findFirst.mockResolvedValue(null);

    const res = await request(app).post('/api/v1/matches/m-1/cancel');

    expect(res.status).toBe(403);
    expect(emitArgs()).toHaveLength(0);
    expect(cancelPreplayMatch).not.toHaveBeenCalled();
  });

  it('does not notify when the match cannot be cancelled', async () => {
    const { MatchNotCancellableError } = await import('../../../services/gameActivationService.js');
    cancelPreplayMatch.mockRejectedValue(
      new MatchNotCancellableError('Match is in play and cannot be cancelled')
    );

    const res = await request(app).post('/api/v1/matches/m-1/cancel');

    expect(res.status).toBe(409);
    expect(emitArgs()).toHaveLength(0);
  });

  it('still answers the canceller when the socket has no io yet', async () => {
    const sockets = await import('../../../sockets/index.js');
    sockets.getIO.mockReturnValueOnce(undefined);
    cancelPreplayMatch.mockResolvedValue({ matchId: 'm-1', status: 'RELEASED', refunded: true });

    const res = await request(app).post('/api/v1/matches/m-1/cancel');

    expect(res.status).toBe(200);
  });

  it('still answers the canceller when Redis cleanup fails', async () => {
    const { default: redis } = await import('../../../utils/redis.js');
    redis.del.mockRejectedValueOnce(new Error('redis down'));
    cancelPreplayMatch.mockResolvedValue({ matchId: 'm-1', status: 'RELEASED', refunded: true });

    const res = await request(app).post('/api/v1/matches/m-1/cancel');

    // The refund already committed; a cache failure must not report failure.
    expect(res.status).toBe(200);
  });
});