import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockPrisma = {
  matchMove: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn()
  },
  gameEvent: {
    create: jest.fn()
  },
  matchGameState: {
    upsert: jest.fn()
  },
  $transaction: jest.fn(async (fn) => fn(mockPrisma))
};
jest.unstable_mockModule('../../utils/db.js', () => ({ default: mockPrisma }));

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.unstable_mockModule('../../utils/logger.js', () => ({ default: mockLogger }));

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

  time() {
    const now = Date.now();
    return [String(Math.floor(now / 1000)), String((now % 1000) * 1000)];
  }

  eval(_script, _numKeys, key, version, board, currentTurn, currentTurnUserId, moveCount, lastMoveTs, positionCounts, consecutiveKingMoves, status, winnerId, deadlineAt, timeControlSeconds) {
    const hash = this.store.get(key);
    if (!hash) throw new Error('GAME_NOT_FOUND');
    if (String(hash.version) !== String(version)) throw new Error('VERSION_MISMATCH');
    Object.assign(hash, {
      board, currentTurn, currentTurnUserId,
      version: String(parseInt(hash.version, 10) + 1),
      moveCount, lastMoveTs, positionCounts, consecutiveKingMoves,
      status, winnerId, deadlineAt, timeControlSeconds
    });
    return 'OK';
  }
}

const fakeRedis = new FakeRedis();
jest.unstable_mockModule('../../utils/redis.js', () => ({ default: fakeRedis }));
jest.unstable_mockModule('@sentry/node', () => ({ captureException: jest.fn() }));

const mockEmit = jest.fn();
const mockTo = jest.fn().mockReturnValue({ emit: mockEmit });
jest.unstable_mockModule('../index.js', () => ({ getIO: jest.fn(() => ({ to: mockTo })) }));

const settlementMocks = {
  settleGame: jest.fn(),
  settleGameDraw: jest.fn(),
  settleGameWithRetry: jest.fn(),
  settleGameDrawWithRetry: jest.fn()
};
jest.unstable_mockModule('../settlement.js', () => settlementMocks);

const { handleMoveSubmit } = await import('../gameManager.js');
const { EMPTY, WHITE_MAN, BLACK_MAN, COLOR_WHITE } = await import('../../modules/engine/board.js');
const { createInitialBoard, getLegalMoves } = await import('../../modules/engine/index.js');

const buildEndgameBoard = () => {
  const board = new Array(50).fill(EMPTY);
  board[31] = WHITE_MAN; // 32
  board[26] = BLACK_MAN; // 27
  board[16] = BLACK_MAN; // 17
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
    timeControlSeconds: '60',
    deadlineAt: (Date.now() + 60000).toString(),
    ...overrides
  });
};

const p2002 = () => Object.assign(new Error('unique constraint violated'), { code: 'P2002' });
const emitted = (event) => mockEmit.mock.calls.find(([e]) => e === event)?.[1];

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.matchMove.create.mockResolvedValue({ id: 'move-row-id' });
  mockPrisma.matchMove.findUnique.mockResolvedValue(null);
  mockPrisma.gameEvent.create.mockResolvedValue({});
  mockPrisma.matchGameState.upsert.mockResolvedValue({});
});

describe('move.submit V2 protocol', () => {
  it('persists the clientMoveId/path/stateVersion and emits both accepted events', async () => {
    const board = buildEndgameBoard();
    seedMatch('test-match', board, 'white-user', 'black-user');

    const socket = { id: 's1', user: { userId: 'white-user' }, emit: jest.fn() };
    await handleMoveSubmit(socket, {
      matchId: 'test-match',
      clientMoveId: 'cm_12345678',
      expectedStateVersion: 0,
      from: 32,
      path: [32, 21, 12]
    });

    expect(socket.emit).not.toHaveBeenCalled();
    expect(mockPrisma.matchMove.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        matchId: 'test-match',
        moveNumber: 1,
        playerId: 'white-user',
        fromSquare: 32,
        toSquare: 12,
        path: [32, 21, 12],
        clientMoveId: 'cm_12345678',
        stateVersion: 0
      })
    });

    const accepted = emitted('move.accepted');
    expect(accepted).toMatchObject({
      matchId: 'test-match',
      clientMoveId: 'cm_12345678',
      version: '1',
      stateVersion: 1,
      replayed: false
    });
    expect(emitted('move_applied')).toBeDefined();
    expect(settlementMocks.settleGameWithRetry).toHaveBeenCalledTimes(1);
  });

  it('writes the audit GameEvent and MatchGameState projection in the same durable step', async () => {
    const initial = createInitialBoard();
    const opening = getLegalMoves(initial, COLOR_WHITE)[0];
    seedMatch('test-match', initial, 'white-user', 'black-user');

    const socket = { id: 's2', user: { userId: 'white-user' }, emit: jest.fn() };
    await handleMoveSubmit(socket, {
      matchId: 'test-match',
      clientMoveId: 'cm_audit_01',
      expectedStateVersion: 0,
      from: opening.from,
      to: opening.to
    });

    expect(mockPrisma.gameEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        matchId: 'test-match',
        playerId: 'white-user',
        type: 'MOVE',
        payload: expect.objectContaining({
          clientMoveId: 'cm_audit_01',
          moveNumber: 1,
          stateVersion: 0
        })
      })
    });
    expect(mockPrisma.matchGameState.upsert).toHaveBeenCalledWith({
      where: { matchId: 'test-match' },
      create: expect.objectContaining({ matchId: 'test-match', stateVersion: 1, currentTurn: 'DARK' }),
      update: expect.objectContaining({ stateVersion: 1, currentTurn: 'DARK' })
    });
  });

  it('returns the previous accepted result for a duplicate clientMoveId without a second broadcast', async () => {
    const board = buildEndgameBoard();
    seedMatch('test-match', board, 'white-user', 'black-user', { moveCount: '1', version: '1' });
    mockPrisma.matchMove.findUnique.mockResolvedValue({
      moveNumber: 1,
      fromSquare: 32,
      toSquare: 12,
      path: [32, 21, 12],
      capturedSquares: [27, 17],
      isKingMove: false
    });

    const socket = { id: 's3', user: { userId: 'white-user' }, emit: jest.fn() };
    await handleMoveSubmit(socket, {
      matchId: 'test-match',
      clientMoveId: 'cm_dup_0001',
      expectedStateVersion: 1,
      from: 32,
      path: [32, 21, 12]
    });

    expect(mockPrisma.matchMove.create).not.toHaveBeenCalled();
    expect(mockTo).not.toHaveBeenCalled();
    expect(settlementMocks.settleGameWithRetry).not.toHaveBeenCalled();
    const replayed = socket.emit.mock.calls.find(([e]) => e === 'move.accepted')?.[1];
    expect(replayed).toMatchObject({ clientMoveId: 'cm_dup_0001', replayed: true, version: '1' });
    expect(socket.emit.mock.calls.find(([e]) => e === 'match.state')).toBeDefined();
  });

  it('replays an accepted move when the durable unique constraint fires', async () => {
    const board = buildEndgameBoard();
    seedMatch('test-match', board, 'white-user', 'black-user');
    fakeRedis.pushRead({ moveCount: '1', version: '1' });
    mockPrisma.matchMove.create.mockRejectedValue(p2002());
    // Pre-check sees no prior row; the P2002 resolver finds OUR row by key.
    mockPrisma.matchMove.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        moveNumber: 1,
        clientMoveId: 'cm_race_001',
        fromSquare: 32,
        toSquare: 12,
        path: [32, 21, 12],
        capturedSquares: [27, 17],
        isKingMove: false
      });

    const socket = { id: 's4', user: { userId: 'white-user' }, emit: jest.fn() };
    await handleMoveSubmit(socket, {
      matchId: 'test-match',
      clientMoveId: 'cm_race_001',
      expectedStateVersion: 0,
      from: 32,
      path: [32, 21, 12]
    });

    expect(mockTo).not.toHaveBeenCalled();
    const replayed = socket.emit.mock.calls.find(([e]) => e === 'move.accepted')?.[1];
    expect(replayed).toMatchObject({ clientMoveId: 'cm_race_001', replayed: true });
  });

  it('refuses a competing move that merely holds the same moveNumber (no false accept)', async () => {
    const board = buildEndgameBoard();
    seedMatch('test-match', board, 'white-user', 'black-user');
    mockPrisma.matchMove.create.mockRejectedValue(p2002());
    mockPrisma.matchMove.findUnique.mockImplementation(async ({ where }) => {
      if (where.matchId_moveNumber) {
        return {
          moveNumber: 1,
          clientMoveId: 'cm_other_player',
          fromSquare: 32,
          toSquare: 21,
          capturedSquares: [],
          isKingMove: false
        };
      }
      return null;
    });

    const socket = { id: 's4b', user: { userId: 'white-user' }, emit: jest.fn() };
    await handleMoveSubmit(socket, {
      matchId: 'test-match',
      clientMoveId: 'cm_loser_001',
      expectedStateVersion: 0,
      from: 32,
      path: [32, 21, 12]
    });

    expect(mockTo).not.toHaveBeenCalled();
    expect(socket.emit.mock.calls.find(([e]) => e === 'move.accepted')).toBeUndefined();
    expect(socket.emit).toHaveBeenCalledWith('move.rejected', { code: 'duplicate_move' });
    expect(socket.emit).toHaveBeenCalledWith('move_rejected', { reason: 'duplicate_move' });
    expect(socket.emit.mock.calls.find(([e]) => e === 'match.state')).toBeDefined();
  });

  it('surfaces server_busy (not a ReferenceError) after exhausting CAS version retries', async () => {
    const board = buildEndgameBoard();
    seedMatch('test-match', board, 'white-user', 'black-user');
    const realEval = fakeRedis.eval;
    fakeRedis.eval = () => { throw new Error('VERSION_MISMATCH'); };
    try {
      const socket = { id: 's4c', user: { userId: 'white-user' }, emit: jest.fn() };
      await handleMoveSubmit(socket, {
        matchId: 'test-match',
        clientMoveId: 'cm_busy_001',
        expectedStateVersion: 0,
        from: 32,
        path: [32, 21, 12]
      });
      expect(socket.emit).toHaveBeenCalledWith('move.rejected', { code: 'server_busy' });
    } finally {
      fakeRedis.eval = realEval;
    }
  });

  it('settles the mover and rejects turn_expired when the CAS clock guard fires', async () => {
    const board = buildEndgameBoard();
    seedMatch('test-match', board, 'white-user', 'black-user');
    const realEval = fakeRedis.eval;
    fakeRedis.eval = () => { throw new Error('TURN_EXPIRED'); };
    try {
      const socket = { id: 's4d', user: { userId: 'white-user' }, emit: jest.fn() };
      await handleMoveSubmit(socket, {
        matchId: 'test-match',
        clientMoveId: 'cm_expire_1',
        expectedStateVersion: 0,
        from: 32,
        path: [32, 21, 12]
      });
      expect(socket.emit).toHaveBeenCalledWith('move.rejected', { code: 'turn_expired' });
      expect(settlementMocks.settleGameWithRetry).toHaveBeenCalledTimes(1);
    } finally {
      fakeRedis.eval = realEval;
    }
  });

  it('rejects game_already_ended (not a ReferenceError) when the CAS reports a vanished game', async () => {
    const board = buildEndgameBoard();
    seedMatch('test-match', board, 'white-user', 'black-user');
    const realEval = fakeRedis.eval;
    fakeRedis.eval = () => { throw new Error('GAME_NOT_FOUND'); };
    try {
      const socket = { id: 's4e', user: { userId: 'white-user' }, emit: jest.fn() };
      await handleMoveSubmit(socket, {
        matchId: 'test-match',
        clientMoveId: 'cm_gone_001',
        expectedStateVersion: 0,
        from: 32,
        path: [32, 21, 12]
      });
      expect(socket.emit).toHaveBeenCalledWith('move.rejected', { code: 'game_already_ended' });
    } finally {
      fakeRedis.eval = realEval;
    }
  });

  it('forces a stale client to resync: version mismatch rejects with match.state', async () => {
    const board = buildEndgameBoard();
    seedMatch('test-match', board, 'white-user', 'black-user', { moveCount: '2', version: '2' });

    const socket = { id: 's5', user: { userId: 'white-user' }, emit: jest.fn() };
    await handleMoveSubmit(socket, {
      matchId: 'test-match',
      clientMoveId: 'cm_stale_01',
      expectedStateVersion: 0,
      from: 32,
      path: [32, 21, 12]
    });

    expect(mockPrisma.matchMove.create).not.toHaveBeenCalled();
    expect(mockTo).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('move.rejected', {
      code: 'stale_state',
      expectedStateVersion: 0,
      currentVersion: 2
    });
    expect(socket.emit).toHaveBeenCalledWith('move_rejected', { reason: 'stale_state' });
    const resync = socket.emit.mock.calls.find(([e]) => e === 'match.state')?.[1];
    expect(resync).toMatchObject({ matchId: 'test-match', version: '2' });
  });

  it('rejects a path that does not match the engine canonical capture chain', async () => {
    const board = buildEndgameBoard();
    seedMatch('test-match', board, 'white-user', 'black-user');

    const socket = { id: 's6', user: { userId: 'white-user' }, emit: jest.fn() };
    await handleMoveSubmit(socket, {
      matchId: 'test-match',
      clientMoveId: 'cm_badpath01',
      expectedStateVersion: 0,
      from: 32,
      to: 12,
      path: [32, 12]
    });

    expect(mockPrisma.matchMove.create).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('move.rejected', {
      code: 'illegal_move',
      reason: 'path_mismatch'
    });
  });

  it('rejects an invalid V2 payload with the stable code', async () => {
    const socket = { id: 's7', user: { userId: 'white-user' }, emit: jest.fn() };
    await handleMoveSubmit(socket, { matchId: 'test-match', from: 32, to: 12 });

    expect(socket.emit).toHaveBeenCalledWith('move.rejected', { code: 'invalid_payload' });
    expect(socket.emit).toHaveBeenCalledWith('move_rejected', { reason: 'invalid_payload' });
    expect(mockPrisma.matchMove.create).not.toHaveBeenCalled();
  });
});
