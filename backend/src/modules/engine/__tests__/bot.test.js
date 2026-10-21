import {
  createInitialBoard,
  getLegalMoves,
  applyMove,
  COLOR_WHITE,
  COLOR_BLACK,
  EMPTY
} from '../index.js';
import {
  chooseBotMove,
  evaluateBoard,
  clampBotLevel,
  botLevelConfig,
  BOT_LEVELS,
  MAX_BOT_LEVEL
} from '../bot.js';

const findEngineMove = (moves, candidate) =>
  moves.find(
    (m) =>
      m.from === candidate.from &&
      m.to === candidate.to &&
      Array.isArray(candidate.path) &&
      m.path.length === candidate.path.length &&
      m.path.every((sq, i) => sq === candidate.path[i])
  );

describe('free-play bot', () => {
  test('returns a legal engine move for both colours from the opening', () => {
    const board = createInitialBoard();
    for (const color of [COLOR_WHITE, COLOR_BLACK]) {
      const move = chooseBotMove(board, color, { level: BOT_LEVELS.MEDIUM });
      expect(move).not.toBeNull();
      const legal = getLegalMoves(board, color);
      expect(findEngineMove(legal, move)).toBeDefined();
    }
  });

  test('returns null only when the side genuinely has no move', () => {
    const board = new Array(50).fill(EMPTY);
    // A white man on 46 with every neighbouring square blocked has no move.
    board[45] = 1;
    board[36] = 3; // black man blocking 37
    board[39] = 3; // black man blocking 40
    const legal = getLegalMoves(board, COLOR_WHITE);
    if (legal.length === 0) {
      expect(chooseBotMove(board, COLOR_WHITE, { level: BOT_LEVELS.EASY })).toBeNull();
    } else {
      expect(chooseBotMove(board, COLOR_WHITE, { level: BOT_LEVELS.EASY })).not.toBeNull();
    }
  });

  test('plays a forced move without searching', () => {
    const board = createInitialBoard();
    // Black man on 16 can only capture to the right.
    const forced = new Array(50).fill(EMPTY);
    forced[15] = 3; // black man on 16
    forced[24] = 1; // white man on 25 -> capturable
    const legal = getLegalMoves(forced, COLOR_BLACK);
    expect(legal.length).toBe(1);
    const move = chooseBotMove(forced, COLOR_BLACK, { level: BOT_LEVELS.EXPERT });
    expect(move.from).toBe(legal[0].from);
    expect(move.to).toBe(legal[0].to);
  });

  test('takes an available capture (the mandatory capture rule makes it forced)', () => {
    const board = new Array(50).fill(EMPTY);
    board[35] = 1; // white man on 36
    board[30] = 3; // black man on 31 -> jumped over, landing on 27
    const legal = getLegalMoves(board, COLOR_WHITE);
    expect(legal.length).toBe(1);
    expect(legal[0].capturedSquares).toEqual([31]);
    const move = chooseBotMove(board, COLOR_WHITE, { level: BOT_LEVELS.MEDIUM });
    expect(move.capturedSquares).toEqual([31]);
    expect(move.from).toBe(36);
    expect(move.to).toBe(27);
  });

  test('evaluation is symmetric and favours material', () => {
    const board = createInitialBoard();
    const white = evaluateBoard(board, COLOR_WHITE);
    const black = evaluateBoard(board, COLOR_BLACK);
    // The opening is symmetric, so both sides score the same magnitude.
    expect(Math.abs(white)).toBe(Math.abs(black));

    const withExtraWhiteKing = [...board];
    withExtraWhiteKing[0] = 2; // white king on square 1
    const improved = evaluateBoard(withExtraWhiteKing, COLOR_WHITE);
    expect(improved).toBeGreaterThan(white);
  });

  test('clamps out-of-range levels', () => {
    expect(clampBotLevel(0)).toBe(1);
    expect(clampBotLevel(99)).toBe(MAX_BOT_LEVEL);
    expect(clampBotLevel('3')).toBe(3);
    expect(clampBotLevel('nonsense')).toBe(BOT_LEVELS.MEDIUM);
    expect(botLevelConfig(3).maxDepth).toBeGreaterThan(botLevelConfig(1).maxDepth);
  });

  test('respects the time budget and always answers', () => {
    const board = createInitialBoard();
    const started = Date.now();
    const move = chooseBotMove(board, COLOR_WHITE, { level: BOT_LEVELS.EXPERT });
    const elapsed = Date.now() - started;
    expect(move).not.toBeNull();
    // The expert budget is 1200 ms; allow generous slack for a loaded CI box
    // but fail loudly if the search ever runs away.
    expect(elapsed).toBeLessThan(4000);
  });

  test('an aborting clock still yields a legal move', () => {
    const board = createInitialBoard();
    // A clock that is already past any deadline forces the search to abort on
    // its first node check.
    const move = chooseBotMove(board, COLOR_WHITE, {
      level: BOT_LEVELS.EXPERT,
      now: () => Number.MAX_SAFE_INTEGER
    });
    expect(move).not.toBeNull();
    const legal = getLegalMoves(board, COLOR_WHITE);
    expect(findEngineMove(legal, move)).toBeDefined();
  });

  test('produces a legal move from a mid-game position', () => {
    const board = createInitialBoard();
    const { newBoard } = applyMove(board, getLegalMoves(board, COLOR_WHITE)[0]);
    const move = chooseBotMove(newBoard, COLOR_BLACK, { level: BOT_LEVELS.HARD });
    expect(move).not.toBeNull();
    const legal = getLegalMoves(newBoard, COLOR_BLACK);
    expect(findEngineMove(legal, move)).toBeDefined();
  });
});
