import { jest, describe, it, expect, beforeEach } from '@jest/globals';

process.env.JWT_SECRET = 'test_secret';

const mockPrisma = {
  match: {
    findMany: jest.fn(),
    findUnique: jest.fn()
  },
  user: {
    findMany: jest.fn()
  }
};
jest.unstable_mockModule('../../../utils/db.js', () => ({
  default: mockPrisma
}));

jest.unstable_mockModule('../../../middleware/auth.js', () => ({
  requireAuth: (req, res, next) => {
    req.user = { id: 'user-1' };
    next();
  }
}));

const mockGameManager = {
  getGameState: jest.fn(),
  reconstructMoveHistory: jest.fn()
};
jest.unstable_mockModule('../../../sockets/gameManager.js', () => mockGameManager);

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.unstable_mockModule('../../../utils/logger.js', () => ({
  default: mockLogger
}));

const express = (await import('express')).default;
const { default: request } = await import('supertest');
const { matchRouter } = await import('../controller.js');
const { createInitialBoard, COLOR_WHITE, COLOR_BLACK } = await import('../../../modules/engine/index.js');

const app = express();
app.use(express.json());
app.use('/matches', matchRouter);

describe('match state HTTP endpoints', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.match.findUnique.mockResolvedValue({
      playerLightId: 'user-1',
      playerDarkId: 'player-2',
      status: 'ACTIVE',
      winnerId: null
    });
  });

  it('returns the live Redis state with match/version identity', async () => {
    const board = createInitialBoard();
    mockGameManager.getGameState.mockResolvedValue({
      board: JSON.stringify(board),
      currentTurn: COLOR_WHITE,
      moveCount: '0',
      version: '2',
      status: 'in_progress',
      winnerId: '',
      player1: 'user-1',
      player2: 'player-2'
    });

    const res = await request(app).get('/matches/match-1/state');

    expect(res.status).toBe(200);
    expect(res.body.matchId).toBe('match-1');
    expect(res.body.version).toBe(2);
    expect(res.body.board).toEqual(board);
    expect(res.body.moveCount).toBe(0);
    expect(res.body.players).toEqual({ light: 'user-1', dark: 'player-2' });
  });

  it('rebuilds state from the durable move log when Redis state is gone', async () => {
    const rebuiltBoard = createInitialBoard();
    mockGameManager.getGameState.mockResolvedValue(null);
    mockGameManager.reconstructMoveHistory.mockResolvedValue({
      board: rebuiltBoard,
      currentTurn: COLOR_BLACK,
      moveCount: 3,
      rows: []
    });

    const res = await request(app).get('/matches/match-2/state');

    expect(res.status).toBe(200);
    expect(res.body.matchId).toBe('match-2');
    expect(res.body.version).toBe(3);
    expect(res.body.currentTurn).toBe(COLOR_BLACK);
    expect(res.body.board).toEqual(rebuiltBoard);
    expect(mockGameManager.reconstructMoveHistory).toHaveBeenCalledWith('match-2');
  });

  it('returns the pristine starting position for a fresh match with no moves logged', async () => {
    mockGameManager.getGameState.mockResolvedValue(null);
    mockGameManager.reconstructMoveHistory.mockResolvedValue(null);

    const res = await request(app).get('/matches/match-3/state');

    expect(res.status).toBe(200);
    expect(res.body.matchId).toBe('match-3');
    expect(res.body.version).toBe(0);
    expect(res.body.moveCount).toBe(0);
    expect(res.body.board).toHaveLength(50);
  });

  it('rejects a request for a match the user is not part of', async () => {
    mockPrisma.match.findUnique.mockResolvedValue({
      playerLightId: 'someone-else',
      playerDarkId: 'player-2',
      status: 'ACTIVE',
      winnerId: null
    });

    const res = await request(app).get('/matches/match-4/state');
    expect(res.status).toBe(403);
  });

  it('sanitizes the completed match history list', async () => {
    mockPrisma.match.findMany.mockResolvedValue([
      {
        id: 'm-1',
        playerLightId: 'user-1',
        playerDarkId: 'user-2',
        tier: 'PRO',
        stakeMinorUnits: 100000n,
        status: 'COMPLETED',
        winnerId: 'user-1',
        endReason: 'NO_LEGAL_MOVES',
        createdAt: new Date(),
        endedAt: new Date()
      }
    ]);
    mockPrisma.user.findMany.mockResolvedValue([
      { id: 'user-1', email: 'a@test.local' },
      { id: 'user-2', email: 'b@test.local' }
    ]);

    const res = await request(app).get('/matches/history');

    expect(res.status).toBe(200);
    expect(res.body.matches).toHaveLength(1);
    expect(res.body.matches[0].id).toBe('m-1');
    expect(res.body.matches[0].stakeMinorUnits).toBe('100000');
    expect(res.body.matches[0].playerLight).toEqual({ id: 'user-1', email: 'a@test.local' });
  });
});