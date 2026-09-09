import { jest } from '@jest/globals';

const mockPrisma = {
  matchMove: {
    create: jest.fn().mockResolvedValue({})
  }
};
jest.unstable_mockModule('../../utils/db.js', () => ({
  default: mockPrisma
}));

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
};
jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: mockLogger
}));

class FakeRedis {
  constructor() {
    this.store = new Map();
  }

  hset(key, obj) {
    const hash = this.store.get(key) || {};
    Object.assign(hash, obj);
    this.store.set(key, hash);
    return 1;
  }

  hgetall(key) {
    const hash = this.store.get(key);
    return hash ? { ...hash } : {};
  }

  hmget(key, ...fields) {
    const hash = this.store.get(key) || {};
    return fields.map((field) => hash[field] ?? null);
  }

  get(key) {
    return this.store.get(key) ?? null;
  }

  set(key, value) {
    this.store.set(key, value);
    return 'OK';
  }

  expire() {
    return 1;
  }

  del(key) {
    return this.store.delete(key) ? 1 : 0;
  }

  eval(_script, _numKeys, key, version, board, currentTurn, currentTurnUserId, moveCount, lastMoveTs, positionCounts, consecutiveKingMoves, status, winnerId) {
    const hash = this.store.get(key);
    if (!hash) throw new Error('GAME_NOT_FOUND');
    if (String(hash.version) !== String(version)) throw new Error('VERSION_MISMATCH');
    Object.assign(hash, {
      board,
      currentTurn,
      currentTurnUserId,
      version: String(parseInt(hash.version, 10) + 1),
      moveCount,
      lastMoveTs,
      positionCounts,
      consecutiveKingMoves,
      status,
      winnerId
    });
    return 'OK';
  }
}

const fakeRedis = new FakeRedis();
jest.unstable_mockModule('../../utils/redis.js', () => ({
  default: fakeRedis
}));

jest.unstable_mockModule('@sentry/node', () => ({
  captureException: jest.fn()
}));

const mockEmit = jest.fn();
const mockTo = jest.fn().mockReturnValue({ emit: mockEmit });
jest.unstable_mockModule('../index.js', () => ({
  getIO: jest.fn(() => ({ to: mockTo }))
}));

const settlementMocks = {
  settleGame: jest.fn(),
  settleGameDraw: jest.fn(),
  settleGameWithRetry: jest.fn(),
  settleGameDrawWithRetry: jest.fn()
};
jest.unstable_mockModule('../settlement.js', () => settlementMocks);

const { handleMoveAttempt } = await import('../gameManager.js');
const { EMPTY, WHITE_MAN, BLACK_MAN, COLOR_WHITE } = await import('../../modules/engine/board.js');

// Endgame: white man on square 32, black men on 27 and 17. White's only legal
// move is a mandatory two-capture chain 32 -> 21 -> 12 taking both black men,
// which leaves black with no pieces and ends the game in a white win.
const buildEndgameBoard = () => {
  const board = new Array(50).fill(EMPTY);
  board[31] = WHITE_MAN; // square 32 (row 6, col 3)
  board[26] = BLACK_MAN; // square 27 (row 5, col 2)
  board[16] = BLACK_MAN; // square 17 (row 3, col 2)
  return board;
};

const seedMatch = (matchId, board, player1, player2) => {
  fakeRedis.store.clear();
  fakeRedis.hset(`match:${matchId}`, {
    player1,
    player2,
    currentTurn: COLOR_WHITE,
    currentTurnUserId: player1,
    board: JSON.stringify(board),
    status: 'in_progress',
    winnerId: '',
    stakeTier: 'AMATEUR',
    moveCount: '0',
    version: '0',
    positionCounts: JSON.stringify({ [JSON.stringify([board, COLOR_WHITE])]: 1 }),
    consecutiveKingMoves: '0',
    lastMoveTs: Date.now().toString()
  });
};

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('complete game smoke', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('plays a complete game: mandatory multi-capture wins, game ends once, settlement is triggered once, and the move is persisted', async () => {
    const board = buildEndgameBoard();
    seedMatch('test-match', board, 'white-user', 'black-user');

    const socket = { id: 's1', user: { userId: 'white-user' }, emit: jest.fn() };
    await handleMoveAttempt(socket, { matchId: 'test-match', from: 32, to: 12 });

    expect(socket.emit).not.toHaveBeenCalled();
    expect(mockTo).toHaveBeenCalledWith('match:test-match');

    const applied = mockEmit.mock.calls.find(([event]) => event === 'move_applied')[1];
    expect(applied.gameEnded).toBe(true);
    expect(applied.reason).toBe('NO_LEGAL_MOVES');
    expect(applied.captured).toEqual([27, 17]);
    expect(applied.board[11]).toBe(WHITE_MAN); // landed on square 12
    expect(applied.board.filter((p) => p !== EMPTY)).toEqual([WHITE_MAN]);

    expect(settlementMocks.settleGameWithRetry).toHaveBeenCalledTimes(1);
    expect(settlementMocks.settleGameWithRetry).toHaveBeenCalledWith(
      'test-match',
      'white-user',
      'black-user',
      'NO_LEGAL_MOVES'
    );
    expect(settlementMocks.settleGameDrawWithRetry).not.toHaveBeenCalled();

    await flushPromises();
    expect(mockPrisma.matchMove.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        matchId: 'test-match',
        moveNumber: 1,
        playerId: 'white-user',
        fromSquare: 32,
        toSquare: 12,
        capturedSquares: [27, 17],
        isKingMove: false
      })
    });
  });

  it('rejects a move from the wrong player and does not settle or mutate state', async () => {
    const board = buildEndgameBoard();
    seedMatch('test-match', board, 'white-user', 'black-user');

    const socket = { id: 's2', user: { userId: 'black-user' }, emit: jest.fn() };
    await handleMoveAttempt(socket, { matchId: 'test-match', from: 32, to: 12 });

    expect(socket.emit).toHaveBeenCalledWith('move_rejected', { reason: 'not_your_turn' });
    expect(settlementMocks.settleGameWithRetry).not.toHaveBeenCalled();
    expect(mockTo).not.toHaveBeenCalled();
    expect(fakeRedis.store.get('match:test-match').version).toBe('0');
  });
});