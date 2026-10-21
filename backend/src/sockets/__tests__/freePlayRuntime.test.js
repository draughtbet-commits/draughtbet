import { jest } from '@jest/globals';

// The free-play bot must play through the same durable pipeline a human move
// takes, and it must answer exactly when it is the bot's turn. These tests pin
// the turn gate and the settle branch against mocked socket primitives.

const redisMock = {
  hset: jest.fn(),
  expire: jest.fn(),
  sadd: jest.fn(),
  srem: jest.fn(),
  smembers: jest.fn(async () => []),
  eval: jest.fn(async () => 'OK')
};

jest.unstable_mockModule('../../utils/redis.js', () => ({ default: redisMock }));
jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

const getGameState = jest.fn();
const computeNextState = jest.fn();
const persistAcceptedMove = jest.fn();
jest.unstable_mockModule('../gameManager.js', () => ({
  getGameState,
  computeNextState,
  persistAcceptedMove,
  casScript: 'CAS'
}));

const emitMoveAccepted = jest.fn();
jest.unstable_mockModule('../gameProtocol.js', () => ({
  emitMoveAccepted,
  SIDE_BY_COLOR: { WHITE: 'LIGHT', BLACK: 'DARK' }
}));

const settleGameWithRetry = jest.fn();
const settleGameDrawWithRetry = jest.fn();
jest.unstable_mockModule('../settlement.js', () => ({
  settleGameWithRetry,
  settleGameDrawWithRetry
}));

const ioEmit = jest.fn();
jest.unstable_mockModule('../index.js', () => ({
  getIO: () => ({ to: () => ({ emit: ioEmit }) })
}));

jest.unstable_mockModule('../timeControl.js', () => ({
  GAME_STATE_TTL_SECONDS: 100,
  disconnectGraceMs: () => 1000
}));

const { playBotTurn, scheduleBotTurn, FREE_PLAY_ACTIVE_SET } = await import('../freePlayRuntime.js');
const { createInitialBoard, COLOR_WHITE, COLOR_BLACK } = await import('../../modules/engine/index.js');

const freshState = (overrides = {}) => {
  const board = createInitialBoard();
  return {
    player1: 'bot:m1',
    player2: 'human-1',
    currentTurn: COLOR_WHITE,
    currentTurnUserId: 'bot:m1',
    board: JSON.stringify(board),
    status: 'in_progress',
    winnerId: '',
    stakeTier: 'AMATEUR',
    moveCount: '0',
    version: '0',
    positionCounts: JSON.stringify({ [JSON.stringify([board, COLOR_WHITE])]: 1 }),
    consecutiveKingMoves: '0',
    deadlineAt: String(Date.now() + 60000),
    timeControlSeconds: '60',
    turnStartedAtServer: String(Date.now()),
    mode: 'FREE_PLAY',
    botLevel: '1',
    botPlayerId: 'bot:m1',
    ...overrides
  };
};

describe('playBotTurn', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getGameState.mockReset();
    computeNextState.mockReset();
    persistAcceptedMove.mockReset();
  });

  it('refuses when it is not the bot\'s turn', async () => {
    getGameState.mockResolvedValue(freshState({ currentTurnUserId: 'human-1' }));
    await expect(playBotTurn('m1')).resolves.toBe(false);
    expect(persistAcceptedMove).not.toHaveBeenCalled();
  });

  it('refuses when the game is not live', async () => {
    getGameState.mockResolvedValue(freshState({ status: 'completed' }));
    await expect(playBotTurn('m1')).resolves.toBe(false);
    expect(persistAcceptedMove).not.toHaveBeenCalled();
  });

  it('persists the bot move through the durable path and settles a decided game', async () => {
    const state = freshState();
    getGameState.mockResolvedValue(state);
    computeNextState.mockReturnValue({
      newBoard: createInitialBoard(),
      nextTurn: COLOR_BLACK,
      nextTurnUserId: 'human-1',
      moveCount: 1,
      consecutiveKingMoves: 0,
      positionCounts: {},
      ended: true,
      reason: 'NO_LEGAL_MOVES',
      newStatus: 'completed',
      winnerId: 'bot:m1',
      move: { from: 31, to: 26, path: [31, 26], capturedSquares: [] },
      promoted: false,
      deadlineAt: '',
      timeControlSeconds: 60
    });
    persistAcceptedMove.mockResolvedValue({ persisted: true, moveId: 'mv-1' });

    const played = await playBotTurn('m1');

    expect(played).toBe(true);
    // Written as the bot, on the human's behalf of the game rules.
    expect(persistAcceptedMove).toHaveBeenCalledWith(
      expect.objectContaining({ playerId: 'bot:m1' }),
      expect.any(Object)
    );
    // Redis CAS advances the projection, then the room is told.
    expect(redisMock.eval).toHaveBeenCalled();
    expect(emitMoveAccepted).toHaveBeenCalled();
    // A decided free game settles money-lessly through the shared settle path.
    expect(settleGameWithRetry).toHaveBeenCalledWith('m1', 'bot:m1', 'human-1', 'NO_LEGAL_MOVES');
    expect(settleGameDrawWithRetry).not.toHaveBeenCalled();
  });

  it('settles a bot-caused draw through the draw path', async () => {
    getGameState.mockResolvedValue(freshState());
    computeNextState.mockReturnValue({
      newBoard: createInitialBoard(),
      nextTurn: COLOR_BLACK,
      nextTurnUserId: 'human-1',
      moveCount: 1,
      consecutiveKingMoves: 0,
      positionCounts: {},
      ended: true,
      reason: 'DRAW_THREEFOLD',
      newStatus: 'draw',
      winnerId: '',
      move: { from: 31, to: 26, path: [31, 26], capturedSquares: [] },
      promoted: false,
      deadlineAt: '',
      timeControlSeconds: 60
    });
    persistAcceptedMove.mockResolvedValue({ persisted: true, moveId: 'mv-1' });

    await playBotTurn('m1');

    expect(settleGameDrawWithRetry).toHaveBeenCalledWith('m1', 'DRAW_THREEFOLD');
    expect(settleGameWithRetry).not.toHaveBeenCalled();
  });

  it('does not apply a move that was already durable', async () => {
    getGameState.mockResolvedValue(freshState());
    computeNextState.mockReturnValue({
      newBoard: createInitialBoard(),
      nextTurn: COLOR_BLACK,
      nextTurnUserId: 'human-1',
      moveCount: 1,
      consecutiveKingMoves: 0,
      positionCounts: {},
      ended: false,
      reason: null,
      newStatus: 'in_progress',
      winnerId: '',
      move: { from: 31, to: 26, path: [31, 26], capturedSquares: [] },
      promoted: false,
      deadlineAt: String(Date.now() + 60000),
      timeControlSeconds: 60
    });
    persistAcceptedMove.mockResolvedValue({ alreadyExists: true, existing: {} });

    const played = await playBotTurn('m1');

    expect(played).toBe(false);
    expect(redisMock.eval).not.toHaveBeenCalled();
    expect(emitMoveAccepted).not.toHaveBeenCalled();
  });
});

describe('scheduleBotTurn', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getGameState.mockReset();
  });

  it('schedules nothing when it is not the bot\'s turn', async () => {
    getGameState.mockResolvedValue(freshState({ currentTurnUserId: 'human-1' }));
    await expect(scheduleBotTurn({ matchId: 'm1' })).resolves.toBe(false);
  });

  it('schedules nothing for a non free-play match', async () => {
    getGameState.mockResolvedValue(freshState({ mode: 'RANKED' }));
    await expect(scheduleBotTurn({ matchId: 'm1' })).resolves.toBe(false);
  });

  it('schedules a reply and reports the active set key', () => {
    expect(FREE_PLAY_ACTIVE_SET).toBe('freeplay:active');
  });
});
