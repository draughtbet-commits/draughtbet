/**
 * Free-play runtime — the live half of a solo game against the bot.
 *
 * Responsibilities:
 *   1. Seed the Redis projection for a free-play match (no `activeMatch`
 *      pointer: a practice game must never hijack the player's "you have an
 *      active match" state, and must never block real matchmaking).
 *   2. Play the bot's moves through the same durable pipeline the human's
 *      moves use — same engine, same move log, same Redis CAS, same room
 *      broadcast — so the game history, the reconnect path and the replay are
 *      identical to a competitive match.
 *   3. Re-drive a stalled bot turn. The bot's reply is scheduled with a timer
 *      for responsiveness, and a sweep re-drives it if the process restarts
 *      (or the timer is lost) between the human's move and the bot's reply.
 *
 * The bot never touches money: settlement for a free-play match is handled by
 * the free-play branch of the settlement service.
 */

import redis from '../utils/redis.js';
import logger from '../utils/logger.js';
import cron from 'node-cron';
import {
  createInitialBoard,
  getLegalMoves,
  isKing,
  COLOR_WHITE
} from '../modules/engine/index.js';
import { chooseBotMove, BOT_LEVELS, BOT_THINK_DELAY_MS } from '../modules/engine/bot.js';
import { FREE_PLAY_MODE } from '../modules/v2/freePlayService.js';
import {
  getGameState,
  computeNextState,
  persistAcceptedMove,
  casScript
} from './gameManager.js';
import { emitMoveAccepted, SIDE_BY_COLOR } from './gameProtocol.js';
import { settleGameWithRetry, settleGameDrawWithRetry } from './settlement.js';
import { getIO } from './index.js';
import { GAME_STATE_TTL_SECONDS, disconnectGraceMs } from './timeControl.js';

// Free-play matches with a live projection. The sweep walks this set instead
// of scanning the whole keyspace, and prunes entries whose game is over.
const FREE_PLAY_ACTIVE_SET = 'freeplay:active';

// Scheduled bot replies, keyed by match id. A pending timer is replaced rather
// than duplicated, so a rapid human move never queues two bot replies.
const pendingTimers = new Map();

const levelOf = (state) => {
  const parsed = Number.parseInt(String(state?.botLevel ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 4 ? parsed : BOT_LEVELS.MEDIUM;
};

const thinkDelayFor = (level) => BOT_THINK_DELAY_MS[level] ?? BOT_THINK_DELAY_MS[BOT_LEVELS.MEDIUM];

/**
 * Seeds the live projection for a free-play match. The game is live from the
 * first move: there is no ready gate (no second human) and no funding step.
 */
export const initializeFreePlayGame = async ({
  matchId,
  humanId,
  botId,
  side,
  tier,
  timeControlSeconds,
  botLevel
}) => {
  const matchKey = `match:${matchId}`;
  const board = createInitialBoard();
  const boardHash = JSON.stringify([board, COLOR_WHITE]);
  const now = Date.now();

  const player1 = side === 'LIGHT' ? humanId : botId;
  const player2 = side === 'LIGHT' ? botId : humanId;

  const initialState = {
    player1,
    player2,
    currentTurn: COLOR_WHITE,
    currentTurnUserId: player1,
    board: JSON.stringify(board),
    // Staged, not live: the turn clock opens when the player joins the room
    // (the join handler upgrades the projection), so the player is never
    // charged for the time spent getting to the board.
    status: 'ready_pending',
    winnerId: '',
    stakeTier: tier,
    moveCount: 0,
    version: 0,
    positionCounts: JSON.stringify({ [boardHash]: 1 }),
    consecutiveKingMoves: 0,
    lastMoveTs: now,
    deadlineAt: '',
    timeControlSeconds,
    turnStartedAtServer: '',
    disconnectGraceMs: disconnectGraceMs(),
    // Free-play markers: read back by the sweep and the bot driver.
    mode: FREE_PLAY_MODE,
    botLevel: String(botLevel),
    botPlayerId: botId
  };

  await redis.hset(matchKey, initialState);
  await redis.expire(matchKey, GAME_STATE_TTL_SECONDS);
  await redis.sadd(FREE_PLAY_ACTIVE_SET, matchId);

  return {
    ...initialState,
    board,
    positionCounts: { [boardHash]: 1 },
    legalMoves: getLegalMoves(board, COLOR_WHITE)
  };
};

/**
 * Plays the bot's move for `matchId`, if it is the bot's turn.
 *
 * The move is produced by the engine's own move generator, so it is legal by
 * construction, and it is written through the same durable path a human move
 * takes: MatchMove + GameEvent + MatchGameState, then the Redis CAS, then the
 * room broadcast. Nothing about the bot is trusted from the client.
 */
export const playBotTurn = async (matchId) => {
  const state = await getGameState(matchId);
  if (!state || state.status !== 'in_progress') return false;
  const botId = state.botPlayerId;
  if (!botId || state.currentTurnUserId !== botId) return false;

  let board;
  try {
    board = JSON.parse(state.board);
  } catch (err) {
    logger.warn({ err, matchId }, 'Free play: unreadable board projection');
    return false;
  }

  const level = levelOf(state);
  const move = chooseBotMove(board, state.currentTurn, { level });
  if (!move) {
    logger.warn({ matchId }, 'Free play: bot has no legal move');
    return false;
  }

  const nowMs = Date.now();
  const nextState = computeNextState(state, move.from, move.to, nowMs, move.path ?? null);
  if (nextState.error) {
    logger.error({ matchId, error: nextState.error }, 'Free play: bot move rejected by the engine');
    return false;
  }

  const {
    newBoard, nextTurn, nextTurnUserId, moveCount, consecutiveKingMoves,
    positionCounts, ended, reason, newStatus, winnerId, promoted,
    deadlineAt, timeControlSeconds
  } = nextState;

  const pieceMoved = board[move.from - 1];
  const canonicalPath = move.path ?? [move.from, move.to];
  const captured = move.capturedSquares || [];
  const nextVersion = Number.parseInt(state.version, 10) + 1;
  const clientMoveId = `bot:${matchId}:${moveCount}`;

  try {
    const persisted = await persistAcceptedMove(
      {
        matchId,
        moveNumber: moveCount,
        playerId: botId,
        fromSquare: move.from,
        toSquare: move.to,
        capturedSquares: captured,
        isKingMove: isKing(pieceMoved),
        boardStateAfter: newBoard,
        clientMoveId,
        path: canonicalPath,
        stateVersion: Number(state.version)
      },
      {
        boardState: newBoard,
        currentTurn: SIDE_BY_COLOR[nextTurn],
        stateVersion: nextVersion,
        turnStartedAt: new Date(nowMs),
        whiteRemainingMs: timeControlSeconds * 1000,
        blackRemainingMs: timeControlSeconds * 1000
      }
    );
    if (persisted.alreadyExists) {
      // The move was already recorded (a retry after a crash between the
      // durable write and the projection apply). The sweep will re-drive it.
      logger.info({ matchId, moveNumber: moveCount }, 'Free play: bot move already durable');
      return false;
    }
  } catch (err) {
    logger.error({ err, matchId }, 'Free play: bot move persist failed');
    return false;
  }

  try {
    await redis.eval(
      casScript,
      1,
      `match:${matchId}`,
      state.version,
      JSON.stringify(newBoard),
      nextTurn,
      nextTurnUserId,
      moveCount.toString(),
      nowMs.toString(),
      JSON.stringify(positionCounts),
      consecutiveKingMoves.toString(),
      newStatus,
      winnerId,
      deadlineAt,
      timeControlSeconds.toString(),
      newStatus === 'in_progress' ? nowMs.toString() : ''
    );
  } catch (err) {
    logger.error({ err, matchId }, 'Free play: bot move projection failed');
    return false;
  }

  const io = getIO();
  const nextLegalMoves = ended ? [] : getLegalMoves(newBoard, nextTurn);
  emitMoveAccepted(io, matchId, {
    clientMoveId,
    move: {
      from: move.from,
      to: move.to,
      path: canonicalPath,
      captured,
      promoted,
      nextTurn,
      ended,
      reason,
      legalMoves: nextLegalMoves,
      newBoard,
      version: nextVersion
    },
    clock: {
      serverNowMs: nowMs,
      turnStartedAtServer: newStatus === 'in_progress' ? nowMs : null,
      deadlineAt: Number(deadlineAt) > 0 ? Number(deadlineAt) : null,
      remainingMs: newStatus === 'in_progress' ? Number(deadlineAt) - nowMs : null
    }
  });

  if (ended) {
    if (newStatus === 'completed') {
      const loserId = winnerId === state.player1 ? state.player2 : state.player1;
      await settleGameWithRetry(matchId, winnerId, loserId, reason);
    } else {
      await settleGameDrawWithRetry(matchId, reason);
    }
  }

  return true;
};

/**
 * Schedules the bot's reply to a move that just landed. The delay gives the
 * bot a human rhythm; the sweep is the safety net if this timer is lost.
 */
export const scheduleBotTurn = async ({ matchId }) => {
  const state = await getGameState(matchId);
  if (!state || state.mode !== FREE_PLAY_MODE) return false;
  if (state.status !== 'in_progress') return false;
  if (state.currentTurnUserId !== state.botPlayerId) return false;

  const delay = thinkDelayFor(levelOf(state));
  const existing = pendingTimers.get(matchId);
  if (existing) {
    clearTimeout(existing);
    pendingTimers.delete(matchId);
  }
  const timer = setTimeout(() => {
    pendingTimers.delete(matchId);
    playBotTurn(matchId).catch((err) => {
      logger.error({ err, matchId }, 'Free play: bot turn failed');
    });
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();
  pendingTimers.set(matchId, timer);
  return true;
};

/**
 * Safety net: re-drives a bot turn that never happened (process restart, lost
 * timer, transient failure). It only acts on a turn that is old enough for the
 * bot to have answered and that has not already expired — an expired turn is
 * the deadline sweep's business, not the bot's.
 */
export const processFreePlayBotSweep = async ({ now = Date.now() } = {}) => {
  const ids = await redis.smembers(FREE_PLAY_ACTIVE_SET);
  const played = [];
  for (const matchId of ids) {
    try {
      const state = await getGameState(matchId);
      if (!state || state.status !== 'in_progress') {
        await redis.srem(FREE_PLAY_ACTIVE_SET, matchId);
        continue;
      }
      if (state.currentTurnUserId !== state.botPlayerId) continue;

      const turnStarted = Number(state.turnStartedAtServer) || 0;
      if (turnStarted > 0 && now - turnStarted < thinkDelayFor(levelOf(state))) continue;

      const deadline = Number(state.deadlineAt);
      if (Number.isFinite(deadline) && deadline > 0 && now > deadline) continue;

      const moved = await playBotTurn(matchId);
      if (moved) played.push(matchId);
    } catch (err) {
      logger.warn({ err, matchId }, 'Free play: bot sweep failed for match');
    }
  }
  return { played };
};

export const startFreePlayBotSweep = () => {
  cron.schedule('*/2 * * * * *', async () => {
    try {
      await processFreePlayBotSweep();
    } catch (err) {
      logger.error({ err }, 'Free play bot sweep: iteration failed');
    }
  });
  logger.info('Started free play bot sweep job');
};

export { FREE_PLAY_ACTIVE_SET };
