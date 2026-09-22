import { jest } from '@jest/globals';

const mockPrisma = {
  $transaction: async (cb) => cb(mockPrisma),
  match: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), findMany: jest.fn() },
  matchMove: { findMany: jest.fn() },
  gameEvent: { findMany: jest.fn() },
  matchSettlement: { findUnique: jest.fn() },
  matchReceipt: { findMany: jest.fn() },
  adminRoleAssignment: { findMany: jest.fn() },
  gameOutbox: { updateMany: jest.fn() }
};

jest.unstable_mockModule('../../../utils/db.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.unstable_mockModule('../../../sockets/gameManager.js', () => ({
  initializeGame: jest.fn(),
  getGameState: jest.fn(),
  reconstructMoveHistory: jest.fn()
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
jest.unstable_mockModule('../../../services/matchService.js', () => ({
  lockWalletsInOrder: jest.fn()
}));
jest.unstable_mockModule('../../../modules/stake/service.js', () => ({
  releaseStakes: jest.fn()
}));

const matchService = await import('../service.js');
const { cancelPreplayMatch, MatchNotCancellableError } = await import(
  '../../../services/gameActivationService.js'
);
const { matchRouter } = await import('../controller.js');
const { default: express } = await import('express');
const { default: request } = await import('supertest');

const app = express();
app.use(express.json());
app.use('/api/v1/matches', matchRouter);

describe('match/service markReady', () => {
  const fundedMatch = (over = {}) => ({
    id: 'm-1',
    status: 'FUNDED',
    playerLightId: 'light-1',
    playerDarkId: 'dark-1',
    ...over
  });

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('moves a funded match to READY for a participant', async () => {
    mockPrisma.match.findUnique.mockResolvedValue(fundedMatch());
    mockPrisma.match.update.mockImplementation(async ({ data }) => fundedMatch(data));
    const result = await matchService.markReady(mockPrisma, 'm-1', 'light-1');
    expect(result).toEqual({ matchId: 'm-1', status: 'READY', ready: true });
    expect(mockPrisma.match.update).toHaveBeenCalledWith({
      where: { id: 'm-1' },
      data: { status: 'READY' }
    });
  });

  it('is an idempotent no-op for an already READY match', async () => {
    mockPrisma.match.findUnique.mockResolvedValue(fundedMatch({ status: 'READY' }));
    const result = await matchService.markReady(mockPrisma, 'm-1', 'dark-1');
    expect(result).toEqual({ matchId: 'm-1', status: 'READY', ready: true });
    expect(mockPrisma.match.update).not.toHaveBeenCalled();
  });

  it('rejects a non-participant', async () => {
    mockPrisma.match.findUnique.mockResolvedValue(fundedMatch());
    await expect(matchService.markReady(mockPrisma, 'm-1', 'intruder')).rejects.toBeInstanceOf(
      matchService.NotParticipantError
    );
  });

  it('rejects readying a match that is not funded', async () => {
    mockPrisma.match.findUnique.mockResolvedValue(fundedMatch({ status: 'IN_PLAY' }));
    await expect(matchService.markReady(mockPrisma, 'm-1', 'light-1')).rejects.toBeInstanceOf(
      matchService.MatchNotReadyError
    );
  });

  it('throws MatchNotFound for a missing match', async () => {
    mockPrisma.match.findUnique.mockResolvedValue(null);
    await expect(matchService.markReady(mockPrisma, 'm-1', 'light-1')).rejects.toBeInstanceOf(
      matchService.MatchNotFoundError
    );
  });
});

describe('gameActivation cancelPreplayMatch', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  const prePlayMatch = (over = {}) => ({
    id: 'm-1',
    status: 'OPEN',
    playerLightId: 'light-1',
    playerDarkId: 'dark-1',
    stakeMinorUnits: '5000',
    ...over
  });

  it('cancels an OPEN match with no money touched', async () => {
    mockPrisma.match.findUnique.mockResolvedValue(prePlayMatch());
    mockPrisma.match.update.mockImplementation(async ({ data }) => ({ id: 'm-1', ...data }));
    const result = await cancelPreplayMatch('m-1');
    expect(result).toEqual({ matchId: 'm-1', status: 'CANCELLED', refunded: false });
    expect(mockPrisma.match.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED' }) })
    );
    expect(mockPrisma.gameOutbox.updateMany).not.toHaveBeenCalled();
  });

  it('releases both stakes for a FUNDED match and freezes the outbox', async () => {
    const { lockWalletsInOrder } = await import('../../../services/matchService.js');
    const { releaseStakes } = await import('../../../modules/stake/service.js');
    mockPrisma.match.findUnique.mockResolvedValue(prePlayMatch({ status: 'FUNDED' }));
    mockPrisma.match.update.mockImplementation(async ({ data }) => ({ id: 'm-1', status: 'FUNDED', ...data }));
    lockWalletsInOrder.mockResolvedValue([
      { id: 'wallet-light', userId: 'light-1' },
      { id: 'wallet-dark', userId: 'dark-1' }
    ]);
    releaseStakes.mockResolvedValue(undefined);
    mockPrisma.gameOutbox.updateMany.mockResolvedValue({ count: 1 });

    const result = await cancelPreplayMatch('m-1');
    expect(result).toEqual({ matchId: 'm-1', status: 'RELEASED', refunded: true });
    expect(releaseStakes).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        matchId: 'm-1',
        amountMinorUnits: 5000n,
        participants: expect.arrayContaining([
          expect.objectContaining({ userId: 'light-1' }),
          expect.objectContaining({ userId: 'dark-1' })
        ])
      })
    );
    expect(mockPrisma.gameOutbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { matchId: 'm-1' },
        data: expect.objectContaining({ status: 'RELEASED' })
      })
    );
  });

  it('refuses to cancel a live match', async () => {
    mockPrisma.match.findUnique.mockResolvedValue(prePlayMatch({ status: 'IN_PLAY' }));
    await expect(cancelPreplayMatch('m-1')).rejects.toBeInstanceOf(MatchNotCancellableError);
  });

  it('throws MatchNotCancellableError for a missing match', async () => {
    mockPrisma.match.findUnique.mockResolvedValue(null);
    await expect(cancelPreplayMatch('m-1')).rejects.toBeInstanceOf(MatchNotCancellableError);
  });
});

describe('match contract HTTP endpoints', () => {
  const settledMatch = (over = {}) => ({
    id: 'm-1',
    playerLightId: 'light-1',
    playerDarkId: 'dark-1',
    status: 'SETTLED',
    winnerId: 'light-1',
    endReason: 'server_result',
    startedAt: new Date('2026-06-01T00:00:00Z'),
    endedAt: new Date('2026-06-01T01:00:00Z'),
    ...over
  });

  beforeEach(() => {
    jest.resetAllMocks();
    mockPrisma.adminRoleAssignment.findMany.mockResolvedValue([]);
  });

  it('GET /matches/:id/receipt returns a settled receipt with derived results', async () => {
    mockPrisma.match.findUnique.mockResolvedValue(settledMatch());
    mockPrisma.matchSettlement.findUnique.mockResolvedValue({
      matchId: 'm-1',
      winnerId: 'light-1',
      endReason: 'server_result',
      settledAt: new Date('2026-06-01T01:00:00Z')
    });
    mockPrisma.matchReceipt.findMany.mockResolvedValue([
      {
        id: 'rc-light',
        matchId: 'm-1',
        userId: 'light-1',
        stakeMinorUnits: 5000n,
        payoutMinorUnits: 9500n,
        feeMinorUnits: 500n,
        createdAt: new Date('2026-06-01T01:00:00Z')
      },
      {
        id: 'rc-dark',
        matchId: 'm-1',
        userId: 'dark-1',
        stakeMinorUnits: 5000n,
        payoutMinorUnits: 0n,
        feeMinorUnits: 0n,
        createdAt: new Date('2026-06-01T01:00:00Z')
      }
    ]);

    const res = await request(app).get('/api/v1/matches/m-1/receipt');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('SETTLED');
    expect(res.body.winnerId).toBe('light-1');
    expect(res.body.receipts).toHaveLength(2);
    expect(res.body.receipts[0]).toMatchObject({ userId: 'light-1', result: 'WIN', payoutMinorUnits: '9500' });
    expect(res.body.receipts[1]).toMatchObject({ userId: 'dark-1', result: 'LOSS' });
  });

  it('GET /matches/:id/receipt reports SETTLEMENT_PENDING before settlement', async () => {
    mockPrisma.match.findUnique.mockResolvedValue(settledMatch({ status: 'RELEASED', winnerId: null }));
    mockPrisma.matchSettlement.findUnique.mockResolvedValue(null);
    mockPrisma.matchReceipt.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/v1/matches/m-1/receipt');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ matchId: 'm-1', status: 'SETTLEMENT_PENDING', receipts: [] });
  });

  it('GET /matches/:id/receipt forbids a stranger', async () => {
    mockPrisma.match.findUnique.mockResolvedValue(
      settledMatch({ playerLightId: 'other-1', playerDarkId: 'other-2' })
    );
    const res = await request(app).get('/api/v1/matches/m-1/receipt');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('GET /matches/:id/receipt allows an admin', async () => {
    mockPrisma.match.findUnique.mockResolvedValue(
      settledMatch({ playerLightId: 'other-1', playerDarkId: 'other-2' })
    );
    mockPrisma.adminRoleAssignment.findMany.mockResolvedValue([{ id: 'role-1' }]);
    mockPrisma.matchSettlement.findUnique.mockResolvedValue(null);
    mockPrisma.matchReceipt.findMany.mockResolvedValue([]);
    const res = await request(app).get('/api/v1/matches/m-1/receipt');
    expect(res.status).toBe(200);
  });

  it('GET /matches/:id/receipt 404s an unknown match', async () => {
    mockPrisma.match.findUnique.mockResolvedValue(null);
    const res = await request(app).get('/api/v1/matches/m-1/receipt');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('MATCH_NOT_FOUND');
  });

  it('GET /matches/:id/replay returns the durable move and event log', async () => {
    mockPrisma.match.findUnique.mockResolvedValue(settledMatch());
    mockPrisma.matchMove.findMany.mockResolvedValue([
      {
        id: 'mv-1',
        matchId: 'm-1',
        moveNumber: 1,
        playerId: 'light-1',
        fromSquare: 'C5',
        toSquare: 'D6',
        capturedSquares: [],
        path: ['C5', 'D6'],
        stateVersion: 1,
        createdAt: new Date('2026-06-01T00:01:00Z')
      }
    ]);
    mockPrisma.gameEvent.findMany.mockResolvedValue([
      { id: 'ev-1', matchId: 'm-1', type: 'MATCH_STARTED', playerId: null, payload: {}, createdAt: new Date('2026-06-01T00:00:00Z') }
    ]);

    const res = await request(app).get('/api/v1/matches/m-1/replay');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ matchId: 'm-1', status: 'SETTLED', winnerId: 'light-1' });
    expect(res.body.moves[0]).toMatchObject({ moveNumber: 1, playerId: 'light-1', from: 'C5', to: 'D6', stateVersion: 1 });
    expect(res.body.events[0]).toMatchObject({ type: 'MATCH_STARTED' });
  });

  it('POST /matches/:id/ready advances a funded participant match', async () => {
    mockPrisma.match.findUnique.mockResolvedValue(settledMatch({ status: 'FUNDED' }));
    mockPrisma.match.update.mockImplementation(async ({ data }) => ({ id: 'm-1', ...data }));
    const res = await request(app).post('/api/v1/matches/m-1/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ matchId: 'm-1', status: 'READY', ready: true });
  });

  it('POST /matches/:id/ready 409s a non-funded match', async () => {
    mockPrisma.match.findUnique.mockResolvedValue(settledMatch({ status: 'IN_PLAY' }));
    const res = await request(app).post('/api/v1/matches/m-1/ready');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MATCH_NOT_READY');
  });

  it('POST /matches/:id/ready 403s a non-participant', async () => {
    mockPrisma.match.findUnique.mockResolvedValue(
      settledMatch({ status: 'FUNDED', playerLightId: 'other-1', playerDarkId: 'other-2' })
    );
    const res = await request(app).post('/api/v1/matches/m-1/ready');
    expect(res.status).toBe(403);
  });

  it('POST /matches/:id/cancel releases a funded match end-to-end', async () => {
    const { lockWalletsInOrder } = await import('../../../services/matchService.js');
    const { releaseStakes } = await import('../../../modules/stake/service.js');
    mockPrisma.match.findUnique.mockResolvedValue(settledMatch({ status: 'FUNDED', stakeMinorUnits: '5000' }));
    mockPrisma.match.update.mockImplementation(async ({ data }) => ({ id: 'm-1', ...data }));
    lockWalletsInOrder.mockResolvedValue([
      { id: 'wallet-light', userId: 'light-1' },
      { id: 'wallet-dark', userId: 'dark-1' }
    ]);
    releaseStakes.mockResolvedValue(undefined);
    mockPrisma.gameOutbox.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app).post('/api/v1/matches/m-1/cancel');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ matchId: 'm-1', status: 'RELEASED', refunded: true });
    expect(releaseStakes).toHaveBeenCalled();
  });

  it('POST /matches/:id/cancel 409s a live match', async () => {
    mockPrisma.match.findUnique.mockResolvedValue(settledMatch({ status: 'IN_PLAY' }));
    const res = await request(app).post('/api/v1/matches/m-1/cancel');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MATCH_CANNOT_BE_CANCELLED');
  });

  it('POST /matches/:id/cancel 403s a stranger', async () => {
    mockPrisma.match.findUnique.mockResolvedValue(
      settledMatch({ status: 'OPEN', playerLightId: 'other-1', playerDarkId: 'other-2' })
    );
    const res = await request(app).post('/api/v1/matches/m-1/cancel');
    expect(res.status).toBe(403);
  });
});