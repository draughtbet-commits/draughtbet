import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockPrisma = {
  matchGameState: { findUnique: jest.fn() },
  matchMove: { findMany: jest.fn() },
  match: { findUnique: jest.fn(), findMany: jest.fn() }
};

jest.unstable_mockModule('../../utils/db.js', () => ({ default: mockPrisma }));

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.unstable_mockModule('../../utils/logger.js', () => ({ default: mockLogger }));

class FakeRedis {
  constructor() {
    this.store = new Map();
    this.zsets = new Map();
  }

  hset(key, obj) {
    const hash = this.store.get(key) || {};
    Object.assign(hash, obj);
    this.store.set(key, hash);
    return 1;
  }

  hgetall(key) {
    return this.store.get(key) ? { ...this.store.get(key) } : {};
  }

  expire() { return 1; }
  set(key, value) { this.store.set(key, value); return 'OK'; }
  zrange(_key) { return [...this.zsets.keys()]; }
  zadd(_key, _score, member) { this.zsets.set(member, _score); return 1; }
  zrem(_key, member) { return this.zsets.delete(member) ? 1 : 0; }
}

const fakeRedis = new FakeRedis();
jest.unstable_mockModule('../../utils/redis.js', () => ({ default: fakeRedis }));

const { reconcileRedisWithDurable, recoverLiveGames } = await import('../gameRecovery.js');
const { createInitialBoard, getLegalMoves, applyMove } = await import('../../modules/engine/index.js');

const buildOneMoveGame = () => {
  const board = createInitialBoard();
  const move = getLegalMoves(board, 'WHITE')[0];
  const applied = applyMove(board, move);
  const turnStartedAt = new Date(1_700_000_000_000);
  return {
    move,
    boardAfter: applied.newBoard,
    durable: {
      boardState: applied.newBoard,
      currentTurn: 'DARK',
      stateVersion: 1,
      turnStartedAt
    },
    row: {
      moveNumber: 1,
      fromSquare: move.from,
      toSquare: move.to,
      path: move.path,
      capturedSquares: move.capturedSquares || []
    },
    match: {
      playerLightId: 'p1',
      playerDarkId: 'p2',
      status: 'IN_PLAY',
      winnerId: null,
      timeControlSeconds: 60
    },
    deadlineAt: turnStartedAt.getTime() + 60000
  };
};

beforeEach(() => {
  jest.clearAllMocks();
  fakeRedis.store.clear();
  fakeRedis.zsets.clear();
});

describe('reconcileRedisWithDurable', () => {
  it('serves the live projection for a legacy match without durable state', async () => {
    fakeRedis.hset('match:m1', { version: '2', board: '[]' });
    mockPrisma.matchGameState.findUnique.mockResolvedValue(null);

    const state = await reconcileRedisWithDurable('m1');
    expect(state.version).toBe('2');
    expect(mockPrisma.matchMove.findMany).not.toHaveBeenCalled();
  });

  it('keeps the live projection when it is at least as advanced as durable', async () => {
    fakeRedis.hset('match:m1', { version: '5', board: '[]' });
    mockPrisma.matchGameState.findUnique.mockResolvedValue({ stateVersion: 5 });

    const state = await reconcileRedisWithDurable('m1');
    expect(state.version).toBe('5');
  });

  it('rebuilds a missing projection from the durable log and clock', async () => {
    const { durable, row, match, boardAfter, deadlineAt } = buildOneMoveGame();
    mockPrisma.matchGameState.findUnique.mockResolvedValue(durable);
    mockPrisma.matchMove.findMany.mockResolvedValue([row]);
    mockPrisma.match.findUnique.mockResolvedValue(match);

    const state = await reconcileRedisWithDurable('m1');

    expect(state.version).toBe('1');
    expect(JSON.parse(state.board)).toEqual(boardAfter);
    expect(state.currentTurn).toBe('BLACK');
    expect(state.currentTurnUserId).toBe('p2');
    expect(state.turnStartedAtServer).toBe(String(durable.turnStartedAt.getTime()));
    expect(Number(state.deadlineAt)).toBe(deadlineAt);
    expect(fakeRedis.store.has('match:m1')).toBe(true);
  });

  it('rebuilds when the live projection is behind the durable version', async () => {
    const { durable, row, match } = buildOneMoveGame();
    fakeRedis.hset('match:m1', { version: '0', board: '[]', player1: 'p1', player2: 'p2' });
    mockPrisma.matchGameState.findUnique.mockResolvedValue(durable);
    mockPrisma.matchMove.findMany.mockResolvedValue([row]);
    mockPrisma.match.findUnique.mockResolvedValue(match);

    const state = await reconcileRedisWithDurable('m1');
    expect(state.version).toBe('1');
  });

  it('never projects a log that does not replay cleanly', async () => {
    const { durable, row, match } = buildOneMoveGame();
    const corruptRow = { ...row, fromSquare: 1, toSquare: 2, path: [1, 2] };
    fakeRedis.hset('match:m1', { version: '0', board: '[]', player1: 'p1', player2: 'p2' });
    mockPrisma.matchGameState.findUnique.mockResolvedValue(durable);
    mockPrisma.matchMove.findMany.mockResolvedValue([corruptRow]);
    mockPrisma.match.findUnique.mockResolvedValue(match);

    const state = await reconcileRedisWithDurable('m1');
    expect(state.version).toBe('0');
    expect(mockLogger.error).toHaveBeenCalled();
    expect(fakeRedis.store.get('match:m1').version).toBe('0');
  });
});

describe('recoverLiveGames', () => {
  it('rehydrates live projections, re-points participants and re-arms disconnects', async () => {
    const { durable, row, match } = buildOneMoveGame();
    mockPrisma.match.findMany.mockResolvedValue([{ id: 'm1' }]);
    mockPrisma.matchGameState.findUnique.mockResolvedValue(durable);
    mockPrisma.matchMove.findMany.mockResolvedValue([row]);
    mockPrisma.match.findUnique.mockResolvedValue(match);
    fakeRedis.hset('match:m1', { disconnectGraceMs: '45000', player1: 'p1', player2: 'p2' });
    fakeRedis.zsets.set('m1:p2', 0);

    const result = await recoverLiveGames();

    expect(result).toMatchObject({ scanned: 1, recovered: 1, rearmed: 1 });
    expect(fakeRedis.store.get('user:p1:activeMatch')).toBe('m1');
    expect(fakeRedis.store.get('user:p2:activeMatch')).toBe('m1');
    expect(fakeRedis.zsets.get('m1:p2')).toBeGreaterThan(Date.now());
  });
});
