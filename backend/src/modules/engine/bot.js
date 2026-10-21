/**
 * Free-play bot.
 *
 * A server-side opponent for FREE_PLAY matches: it plays the side the human
 * did not pick, using the same engine primitives the live game uses
 * (`getLegalMoves` / `applyMove`), so every move it produces is legal by
 * construction — the mandatory maximum-capture rule included.
 *
 * The module is deliberately pure (no Redis, no Prisma, no sockets) so it can
 * be unit-tested and reasoned about on its own. The socket layer owns the
 * durable write; this module only decides *which* move to play.
 *
 * Search: negamax with alpha-beta pruning, iterative deepening and a hard
 * wall-clock budget. Levels map to (max depth, time budget):
 *
 *   1 EASY    depth 1,   60 ms   — greedy, one ply, ties broken at random
 *   2 MEDIUM  depth 3,  250 ms
 *   3 HARD    depth 5,  600 ms
 *   4 EXPERT  depth 7, 1200 ms
 *
 * The budget is a ceiling, never a promise: the search aborts on the next
 * node boundary once the deadline passes and keeps the best move from the
 * last *completed* depth, so the bot always returns a legal move in time.
 */

import {
  EMPTY,
  COLOR_WHITE,
  COLOR_BLACK,
  squareToRowCol,
  getPieceColor,
  isKing
} from './board.js';
import { getLegalMoves } from './moves.js';
import { applyMove } from './apply.js';

export const BOT_LEVELS = Object.freeze({ EASY: 1, MEDIUM: 2, HARD: 3, EXPERT: 4 });

export const MIN_BOT_LEVEL = 1;
export const MAX_BOT_LEVEL = 4;

const LEVEL_CONFIG = Object.freeze({
  1: { maxDepth: 1, timeBudgetMs: 60 },
  2: { maxDepth: 3, timeBudgetMs: 250 },
  3: { maxDepth: 5, timeBudgetMs: 600 },
  4: { maxDepth: 7, timeBudgetMs: 1200 }
});

// How long the bot "thinks" before committing. Independent of the search
// budget: a level that answers instantly feels like a rubber-band opponent.
export const BOT_THINK_DELAY_MS = Object.freeze({
  1: 250,
  2: 450,
  3: 650,
  4: 900
});

const MAN_VALUE = 100;
const KING_VALUE = 300;
// A man is worth more the closer it is to the crown row; a king is worth more
// when it owns the contested middle band.
const ADVANCE_BONUS = 6;
const HOME_ROW_BONUS = 18;
const KING_CENTRE_BONUS = 12;
const MATE_SCORE = 1000000;
const NODE_BUDGET = 200000;

const opponentOf = (color) => (color === COLOR_WHITE ? COLOR_BLACK : COLOR_WHITE);

/** Clamps an arbitrary level input into the supported range. */
export const clampBotLevel = (level) => {
  const parsed = Number.parseInt(String(level), 10);
  if (!Number.isFinite(parsed)) return BOT_LEVELS.MEDIUM;
  if (parsed < MIN_BOT_LEVEL) return MIN_BOT_LEVEL;
  if (parsed > MAX_BOT_LEVEL) return MAX_BOT_LEVEL;
  return parsed;
};

export const botLevelConfig = (level) => LEVEL_CONFIG[clampBotLevel(level)];

/**
 * Static evaluation from the point of view of `color` (the side to move).
 * Positive means the side to move is better off.
 */
export const evaluateBoard = (board, color) => {
  let score = 0;
  for (let sq = 1; sq <= 50; sq++) {
    const piece = board[sq - 1];
    if (piece === EMPTY) continue;
    const pieceColor = getPieceColor(piece);
    if (!pieceColor) continue;
    const sign = pieceColor === color ? 1 : -1;
    const { row } = squareToRowCol(sq);

    if (isKing(piece)) {
      let value = KING_VALUE;
      if (row >= 4 && row <= 5) value += KING_CENTRE_BONUS;
      score += sign * value;
      continue;
    }

    let value = MAN_VALUE;
    // White starts on rows 6-9 and advances toward row 0; black starts on rows
    // 0-3 and advances toward row 9. Both are measured as distance travelled
    // towards the crown row.
    const advance = pieceColor === COLOR_WHITE ? 9 - row : row;
    value += advance * ADVANCE_BONUS;
    // A man still sitting on its own home row cannot be attacked by a man and
    // is expensive to dislodge.
    const homeRow = pieceColor === COLOR_WHITE ? 9 : 0;
    if (row === homeRow) value += HOME_ROW_BONUS;
    score += sign * value;
  }
  return score;
};

/**
 * Orders moves so alpha-beta finds its cut-offs early: captures first, then
 * by evaluation promise. King moves are preferred over quiet man moves at the
 * same capture count because they are the more forcing continuation.
 */
const orderMoves = (moves, board, color) => {
  const scored = moves.map((move, index) => {
    const captures = move.capturedSquares?.length ?? 0;
    const piece = board[move.from - 1];
    const king = isKing(piece) ? 1 : 0;
    const advance = (() => {
      const { row } = squareToRowCol(move.to);
      return color === COLOR_WHITE ? 9 - row : row;
    })();
    return { move, index, key: captures * 1000 + king * 100 + advance };
  });
  scored.sort((a, b) => (b.key - a.key) || (a.index - b.index));
  return scored.map((entry) => entry.move);
};

/**
 * Negamax with alpha-beta pruning. Returns the score for the side to move.
 * `ctx` carries the shared node counter, the deadline and the abort flag.
 */
const search = (board, color, depth, alpha, beta, ctx) => {
  if (ctx.aborted) return 0;
  ctx.nodes += 1;
  if (ctx.nodes > NODE_BUDGET) {
    ctx.aborted = true;
    return 0;
  }
  // Checking the clock every 64 nodes keeps the abort latency negligible
  // without paying for a Date.now() on every single node.
  if ((ctx.nodes & 63) === 0 && ctx.now() > ctx.deadline) {
    ctx.aborted = true;
    return 0;
  }

  const moves = getLegalMoves(board, color);
  // No legal move means the side to move loses — the same rule the engine's
  // terminal detection applies.
  if (moves.length === 0) return -MATE_SCORE;
  if (depth <= 0) return evaluateBoard(board, color);

  let best = -Infinity;
  const ordered = orderMoves(moves, board, color);
  for (const move of ordered) {
    const { newBoard } = applyMove(board, move);
    const score = -search(newBoard, opponentOf(color), depth - 1, -beta, -alpha, ctx);
    if (ctx.aborted) return best === -Infinity ? 0 : best;
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best === -Infinity ? evaluateBoard(board, color) : best;
};

/** Deterministic-ish shuffle so the bot's ties do not always resolve the same way. */
const shuffle = (items, rng) => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

/**
 * Chooses the bot's move for `color` on `board`.
 *
 * Returns the engine's own move object ({ from, to, path, capturedSquares }) so
 * the caller can hand it straight to the durable move pipeline — including the
 * exact capture path, which the server cross-checks against the engine.
 * Returns null when the side has no legal move.
 */
export const chooseBotMove = (
  board,
  color,
  { level = BOT_LEVELS.MEDIUM, now = () => Date.now(), rng = Math.random } = {}
) => {
  const config = botLevelConfig(level);
  const legalMoves = getLegalMoves(board, color);
  if (legalMoves.length === 0) return null;
  // A forced move needs no search at all.
  if (legalMoves.length === 1) return legalMoves[0];

  const deadline = now() + config.timeBudgetMs;
  let best = legalMoves[0];

  for (let depth = 1; depth <= config.maxDepth; depth++) {
    const ctx = { nodes: 0, deadline, aborted: false, now };
    let depthBest = null;
    let depthBestScore = -Infinity;

    // The root order is shuffled so equally-scored moves do not always resolve
    // to the same square — that is what makes the easy levels feel human.
    const rootMoves = shuffle(legalMoves, rng);
    for (const move of rootMoves) {
      const { newBoard } = applyMove(board, move);
      const score = -search(newBoard, opponentOf(color), depth - 1, -Infinity, Infinity, ctx);
      if (ctx.aborted) break;
      if (score > depthBestScore) {
        depthBestScore = score;
        depthBest = move;
      }
    }

    // Only a fully completed depth is trusted; an aborted depth keeps the
    // result of the previous (shallower but complete) one.
    if (depthBest && !ctx.aborted) best = depthBest;
    if (ctx.aborted) break;
  }

  return best;
};
