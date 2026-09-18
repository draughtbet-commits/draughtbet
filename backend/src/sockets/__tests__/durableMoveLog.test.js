import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockPrisma = {
  matchMove: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn().mockResolvedValue(null)
  },
  gameEvent: {
    create: jest.fn().mockResolvedValue({})
  },
  matchGameState: {
    upsert: jest.fn().mockResolvedValue({})
  },
  $transaction: jest.fn(async (fn) => fn(mockPrisma))
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

// In-memory Redis with the CAS Lua behaviour over a versioned hash, plus a
// queue of forced reads so a test can simulate the projection advancing
// between the two reads a duplicate delivery performs.
class FakeRedis {
  constructor() {
    this.store = new Map();
    this.readOverrides = [];
    this.hgetallCalls = 0;
  }

  pushRead(overrides) {
    this.readOverrides.push(overrides);
  }

  hset(key, obj) {
    const hash = this.store.get(key) || {};
    Object.assign(hash, obj);
    this.store.set(key, hash);
    return 1;
  }

  // Overrides apply from the SECOND read onward, so a test can simulate the
  // projection moving forward between the two reads a duplicate delivery
  // performs (loop-top read, then the alreadyExists re-read).
  hgetall(key) {
    this.hgetallCalls++;
    const hash = this.store.get(key);
    if (!hash) return {};
    const merged = { ...hash };
    if (this.hgetallCalls > 1 && this.readOverrides.length > 0) {
      Object.assign(merged, this.readOverrides.shift());
    }
    return merged;
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

  exists(key) {
    return this.store.has(key) ? 1 : 0;
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

const { handleMoveAttempt, reconstructMoveHistory } = await import('../gameManager.js');
const { EMPTY, WHITE_MAN, BLACK_MAN, COLOR_WHITE, COLOR_BLACK } = await import('../../modules/engine/board.js');
const { createInitialBoard, getLegalMoves, applyMove } = await import('../../modules/engine/index.js');

// Endgame: white man on square 32, black men on 27 and 17. White's only legal
// move is the mandatory two-capture chain 32 -> 21 -> 12.
const buildEndgameBoard = () => {
  const board = new Array(50).fill(EMPTY);
  board[31] = WHITE_MAN; // square 32
  board[26] = BLACK_MAN; // square 27
  board[16] = BLACK_MAN; // square 17
  return board;
};

const seedMatch = (matchId, board, player1, player2, overrides = {}) => {
  fakeRedis.store.clear();
  fakeRedis.readOverrides.length = 0;
  fakeRedis.hgetallCalls = 0;
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
    lastMoveTs: Date.now().toString(),
    ...overrides
  });
};

const p2002 = () => Object.assign(new Error('unique constraint violated'), { code: 'P2002' });

beforeEach(() => {
  jest.clearAllMocks();
});

describe('durable accepted-move log (gameManager)', () => {
  it('persists the move before the projection advances and broadcasts match/version identity', async () => {
    const board = buildEndgameBoard();
    seedMatch('test-match', board, 'white-user', 'black-user');

    mockPrisma.matchMove.create.mockResolvedValue({});
    const evalSpy = jest.spyOn(fakeRedis, 'eval');

    const socket = { id: 's1', user: { userId: 'white-user' }, emit: jest.fn() };
    await handleMoveAttempt(socket, { matchId: 'test-match', from: 32, to: 12 });

    // The durable write happened before the CAS that advanced the projection.
    expect(mockPrisma.matchMove.create.mock.invocationCallOrder[0])
      .toBeLessThan(evalSpy.mock.invocationCallOrder[0]);

    const applied = mockEmit.mock.calls.find(([event]) => event === 'move_applied')[1];
    expect(applied.matchId).toBe('test-match');
    expect(applied.version).toBe('1');
    expect(fakeRedis.store.get('match:test-match').moveCount).toBe('1');
  });

  it('rejects the move when the durable write fails, leaving state untouched', async () => {
    const board = buildEndgameBoard();
    seedMatch('test-match', board, 'white-user', 'black-user');

    mockPrisma.matchMove.create.mockRejectedValue(new Error('db unavailable'));

    const socket = { id: 's2', user: { userId: 'white-user' }, emit: jest.fn() };
    await handleMoveAttempt(socket, { matchId: 'test-match', from: 32, to: 12 });

    expect(socket.emit).toHaveBeenCalledWith('move_rejected', { reason: 'persist_failed' });
    expect(mockTo).not.toHaveBeenCalled();
    expect(mockPrisma.matchMove.create).toHaveBeenCalledTimes(3); // retries exhausted
    expect(fakeRedis.store.get('match:test-match').version).toBe('0');
    expect(fakeRedis.store.get('match:test-match').moveCount).toBe('0');
    expect(settlementMocks.settleGameWithRetry).not.toHaveBeenCalled();
  });

  it('resumes the apply of a persisted-but-unapplied move on duplicate delivery', async () => {
    const board = buildEndgameBoard();
    seedMatch('test-match', board, 'white-user', 'black-user');

    // First delivery crashed after the DB write but before the CAS, so the
    // recreate returns P2002 and the projection is still at moveCount 0.
    mockPrisma.matchMove.create.mockRejectedValue(p2002());

    const socket = { id: 's3', user: { userId: 'white-user' }, emit: jest.fn() };
    await handleMoveAttempt(socket, { matchId: 'test-match', from: 32, to: 12 });

    expect(fakeRedis.store.get('match:test-match').moveCount).toBe('1');
    const applied = mockEmit.mock.calls.find(([event]) => event === 'move_applied')[1];
    expect(applied).toBeDefined();
    expect(applied.version).toBe('1');
  });

  it('treats a duplicate delivery of an already-applied move as idempotent without a second broadcast', async () => {
    const board = buildEndgameBoard();
    seedMatch('test-match', board, 'white-user', 'black-user');

    // The projection has already moved to moveCount 1 when the retry re-reads
    // it (the acceptance completed after the persist). The retry must not
    // broadcast again or re-run settlement.
    fakeRedis.pushRead({ moveCount: '1', version: '1' });
    mockPrisma.matchMove.create.mockRejectedValue(p2002());

    const socket = { id: 's4', user: { userId: 'white-user' }, emit: jest.fn() };
    await handleMoveAttempt(socket, { matchId: 'test-match', from: 32, to: 12 });

    expect(fakeRedis.store.get('match:test-match').moveCount).toBe('0');
    expect(mockTo).not.toHaveBeenCalled();
    expect(settlementMocks.settleGameWithRetry).not.toHaveBeenCalled();
  });

  it('replays the durable log through the engine into the reconstructed board', async () => {
    // Build a two-move game with the real engine so the replay is self-checking.
    const initialBoard = createInitialBoard();
    const whiteMove = getLegalMoves(initialBoard, COLOR_WHITE)[0];
    const afterWhite = applyMove(initialBoard, { from: whiteMove.from, to: whiteMove.to }).newBoard;
    const blackMove = getLegalMoves(afterWhite, COLOR_BLACK)[0];
    const afterBlack = applyMove(afterWhite, { from: blackMove.from, to: blackMove.to }).newBoard;

    mockPrisma.matchMove.findMany.mockResolvedValue([
      { moveNumber: 1, fromSquare: whiteMove.from, toSquare: whiteMove.to },
      { moveNumber: 2, fromSquare: blackMove.from, toSquare: blackMove.to }
    ]);

    const rebuilt = await reconstructMoveHistory('test-match');

    expect(rebuilt).not.toBeNull();
    expect(rebuilt.moveCount).toBe(2);
    expect(rebuilt.currentTurn).toBe(COLOR_WHITE);
    expect(rebuilt.board).toEqual(afterBlack);
  });

  it('returns null for an empty durable log', async () => {
    mockPrisma.matchMove.findMany.mockResolvedValue([]);
    expect(await reconstructMoveHistory('empty-match')).toBeNull();
  });
});