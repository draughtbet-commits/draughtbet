import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// POST /api/v1/matches/join-code is the private-room entry point. The code is
// only an address: it must resolve to a listing and then seat the joiner
// through the exact same funding path as an arena join, with the failures the
// app can render (bad code, code-only room, room gone) mapped to real statuses.

const resolvePrivateListingId = jest.fn();
const fundOpenMatch = jest.fn();

const mockPrisma = {
  gameOutbox: { findUnique: jest.fn(async () => null) }
};

jest.unstable_mockModule('../../../utils/db.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.unstable_mockModule('../../../sockets/index.js', () => ({
  getIO: jest.fn(() => ({ to: () => ({ emit: jest.fn() }) }))
}));
jest.unstable_mockModule('../../../sockets/prePlayNotifier.js', () => ({
  clearPrePlayState: jest.fn(),
  notifyPrePlayReleased: jest.fn()
}));
jest.unstable_mockModule('../../../middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.user = { id: 'joiner-1', tier: 'MASTER' };
    next();
  }
}));
jest.unstable_mockModule('../../../middleware/idempotency.js', () => ({
  requireIdempotencyKey: () => (_req, _res, next) => next()
}));
jest.unstable_mockModule('../../../middleware/tierEnforcement.js', () => ({
  requireValidStake: () => (_req, _res, next) => next()
}));
jest.unstable_mockModule('../../../services/gameActivationService.js', () => ({
  finalizeMatchActivation: jest.fn(async () => undefined),
  cancelPreplayMatch: jest.fn(),
  MatchNotCancellableError: class MatchNotCancellableError extends Error {}
}));
jest.unstable_mockModule('../../../modules/notification/service.js', () => ({
  NotificationService: { create: jest.fn(async () => undefined) }
}));
jest.unstable_mockModule('../../../modules/eligibility/service.js', () => ({
  EligibilityService: class {
    canCreateMatch = jest.fn(async () => undefined);
  }
}));
jest.unstable_mockModule('../lifecycleService.js', () => ({
  createOpenMatch: jest.fn(),
  fundOpenMatch,
  resolvePrivateListingId,
  listOpenMatches: jest.fn(),
  listActiveMatches: jest.fn(),
  markReady: jest.fn(),
  buildLifecycleSnapshot: jest.fn(async () => ({})),
  MatchNotFoundError: class MatchNotFoundError extends Error {},
  NotParticipantError: class NotParticipantError extends Error {},
  MatchNotReadyError: class MatchNotReadyError extends Error {},
  JoinUnavailableError: class JoinUnavailableError extends Error {
    constructor(message = 'unavailable') {
      super(message);
      this.name = 'JoinUnavailableError';
    }
  }
}));

const { openMatchRouter } = await import('../openMatchesController.js');
const { default: express } = await import('express');
const { default: request } = await import('supertest');

const app = express();
app.use(express.json());
app.use('/api/v1/matches', openMatchRouter);

const seatedMatch = {
  id: 'm-1',
  playerLightId: 'host-1',
  playerDarkId: 'joiner-1',
  stakeMinorUnits: 100000n
};

describe('POST /matches/join-code', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resolvePrivateListingId.mockResolvedValue('m-1');
    fundOpenMatch.mockResolvedValue(seatedMatch);
  });

  it('resolves the code, seats the joiner via the code path and returns the match', async () => {
    const res = await request(app)
      .post('/api/v1/matches/join-code')
      .send({ code: 'db-2415' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { id: 'm-1' } });
    expect(resolvePrivateListingId).toHaveBeenCalledWith('db-2415');
    expect(fundOpenMatch).toHaveBeenCalledWith('joiner-1', 'm-1', {
      tier: 'MASTER',
      viaCode: true
    });
  });

  it('rejects a missing code with 400 without resolving it', async () => {
    const res = await request(app).post('/api/v1/matches/join-code').send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_ROOM_CODE');
    expect(resolvePrivateListingId).not.toHaveBeenCalled();
  });

  it('maps an unknown code to 404', async () => {
    resolvePrivateListingId.mockRejectedValue(
      Object.assign(new Error('No private room matches that code'), {
        name: 'RoomCodeNotFoundError'
      })
    );

    const res = await request(app)
      .post('/api/v1/matches/join-code')
      .send({ code: 'ABCDEF' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ROOM_NOT_FOUND');
  });

  it('maps a room that can no longer be funded to 409', async () => {
    fundOpenMatch.mockRejectedValue(
      Object.assign(new Error('This open match is no longer open'), {
        name: 'JoinUnavailableError'
      })
    );

    const res = await request(app)
      .post('/api/v1/matches/join-code')
      .send({ code: 'ABCDEF' });

    expect(res.status).toBe(409);
  });
});
