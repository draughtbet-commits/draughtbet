import redis from '../utils/redis.js';
import logger from '../utils/logger.js';
import { validateMatchIdPayload, validateMoveAttempt } from './payloadGuard.js';
import { createInitialBoard, getLegalMoves, applyMove, checkGameEnd, COLOR_WHITE, COLOR_BLACK, isKing } from '../modules/engine/index.js';
import { settleGame, settleGameDraw, settleGameWithRetry, settleGameDrawWithRetry } from './settlement.js';
import { getIO } from './index.js';
import { DEFAULT_TIME_CONTROL_SECONDS, TURN_EXPIRED_REASON } from './timeControl.js';
import prisma from '../utils/db.js';
import { transitionMatchWhere } from '../modules/match/service.js';
import * as Sentry from '@sentry/node';

const GAME_STATE_TTL = 24 * 60 * 60; // 24 hours

// Lua script for atomic compare-and-swap. The expiry guard is embedded in the
// script so a move/resign can never race the turn-deadline sweep: any
// non-ending transition on an expired turn is refused before the state advance.
// Exported for real-Redis integration tests (the string is inert to callers).
export const casScript = `
local key = KEYS[1]
local currentVersion = redis.call('HGET', key, 'version')
if currentVersion == false then
  return redis.error_reply('GAME_NOT_FOUND')
end
if currentVersion ~= ARGV[1] then
  return redis.error_reply('VERSION_MISMATCH')
end
-- Time-control guard: once the current turn's deadline has passed (authoritative
-- Redis clock), no move may advance the game. Ending transitions (resign, win,
-- draw) are still allowed — the deadline sweep settles them.
if ARGV[9] == 'in_progress' then
  local currentDeadline = redis.call('HGET', key, 'deadlineAt')
  if currentDeadline and currentDeadline ~= '' then
    local tim = redis.call('TIME')
    local nowMs = tonumber(tim[1]) * 1000 + math.floor(tonumber(tim[2]) / 1000)
    if tonumber(currentDeadline) < nowMs then
      return redis.error_reply('TURN_EXPIRED')
    end
  end
end
redis.call('HSET', key,
  'board',                  ARGV[2],
  'currentTurn',            ARGV[3],
  'currentTurnUserId',      ARGV[4],
  'version',                tostring(tonumber(currentVersion) + 1),
  'moveCount',              ARGV[5],
  'lastMoveTs',             ARGV[6],
  'positionCounts',         ARGV[7],
  'consecutiveKingMoves',   ARGV[8],
  'status',                 ARGV[9],
  'winnerId',               ARGV[10],
  'deadlineAt',             ARGV[11],
  'timeControlSeconds',     ARGV[12]
)
return 'OK'
`;

// Utility sleep function
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Authoritative server clock (Redis TIME), echoing the guard embedded in the
// CAS script so the pre-persist expiry check agrees with the atomic one.
const authoritativeNowMs = async () => {
  const [seconds, microseconds] = await redis.time();
  return Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000);
};

// Refuses a move whose turn already expired and forfeits the player on the
// clock. Used by the pre-persist check (common case, avoids a phantom log row)
// and by the in-script guard race in the CAS catch (backstop).
const refuseExpiredTurn = (socket, matchId, state, userId) => {
  const opponentId = state.player1 === userId ? state.player2 : state.player1;
  logger.info({ matchId, forfeitedBy: userId, winner: opponentId },
    'Turn expired — auto-forfeit');
  socket.emit('move_rejected', { reason: 'turn_expired' });
  settleGameWithRetry(matchId, opponentId, userId, TURN_EXPIRED_REASON);
};

// Durable write of an accepted move. Returns { persisted: true } on success and
// { alreadyExists: true } when the (matchId, moveNumber) pair is already on the
// log (a duplicate delivery of an accepted move). Throws when the write could
// not be completed after retries — in that case the move is NOT accepted.
async function persistMatchMove(moveData, retries = 3) {
  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await prisma.matchMove.create({ data: moveData });
      return { persisted: true };
    } catch (err) {
      lastErr = err;
      if (err && err.code === 'P2002') {
        return { alreadyExists: true };
      }
      logger.warn({ err, attempt, matchId: moveData.matchId, moveNumber: moveData.moveNumber },
        'MatchMove persist failed, retrying');
      if (attempt < retries) await sleep(attempt * 100);
    }
  }
  logger.error({ err: lastErr, moveData },
    'CRITICAL: MatchMove persist failed after all retries. Move not accepted.');
  if (Sentry && typeof Sentry.captureException === 'function') {
    Sentry.captureException(lastErr, {
      level: 'fatal',
      tags: { subsystem: 'match_audit' },
      extra: { matchId: moveData.matchId, moveNumber: moveData.moveNumber }
    });
  }
  throw lastErr;
}

export const getActiveGameForUser = async (userId) => {
  return await redis.get(`user:${userId}:activeMatch`);
};

export const getOpponentId = async (matchId, userId) => {
  const [p1, p2] = await redis.hmget(`match:${matchId}`, 'player1', 'player2');
  if (p1 === userId) return p2;
  if (p2 === userId) return p1;
  return null;
};

export const getGameState = async (matchId) => {
  const state = await redis.hgetall(`match:${matchId}`);
  if (!state || Object.keys(state).length === 0) return null;
  return state;
};

// Replays the durable move log back into a playable board. The log is the
// source of truth, so this is the repair path when the Redis projection is
// lost and the evidence source settlement can fall back on. Returns null when
// the log is empty.
export const reconstructMoveHistory = async (matchId) => {
  const rows = await prisma.matchMove.findMany({
    where: { matchId },
    orderBy: { moveNumber: 'asc' }
  });
  if (rows.length === 0) return null;

  let board = createInitialBoard();
  for (const row of rows) {
    const applied = applyMove(board, {
      from: row.fromSquare,
      to: row.toSquare,
      capturedSquares: row.capturedSquares || []
    });
    // Prefer the recomputed board so the chain stays continuous; a stored
    // snapshot is only a backstop against a corrupted log.
    board = (applied && applied.newBoard) || row.boardStateAfter;
  }

  return {
    board,
    currentTurn: rows.length % 2 === 1 ? COLOR_BLACK : COLOR_WHITE,
    moveCount: rows.length,
    rows
  };
};

export const initializeGame = async (matchId, player1Id, player2Id, stakeTier) => {
  const matchKey = `match:${matchId}`;

  // Server-authoritative start: once Redis is live for a funded match, the game
  // is PLAYING. Advance the match lifecycle FUNDED/READY -> IN_PLAY with an
  // idempotent CAS (already-live matches are a no-op). This is what lets the
  // deadline sweep forfeit a first-turn timeout before any move was made —
  // settling a READY/FUNDED match is invalid, settling IN_PLAY is correct.
  try {
    await transitionMatchWhere(prisma, matchId, ['FUNDED', 'READY'], 'IN_PLAY', {
      startedAt: new Date()
    });
  } catch (err) {
    // The game is still initialized in Redis; a failed status flip is repaired
    // by the first move or the reconciliation sweep, so never fail init over it.
    logger.warn({ err, matchId }, 'Match lifecycle FUNDED/READY -> IN_PLAY skipped');
  }

  // Idempotent by construction: the durable GameOutbox record is the source of
  // truth here. If Redis already holds state for this match (a crash between
  // the Redis write and the outbox ACTIVATED mark), do NOT clobber a possibly
  // running game — just guarantee the participant pointers and return.
  const stateExists = await redis.exists(matchKey);
  if (stateExists) {
    await redis.set(`user:${player1Id}:activeMatch`, matchId);
    await redis.set(`user:${player2Id}:activeMatch`, matchId);
    return getGameState(matchId);
  }

  // Time control is snapshotted from the Match row (taken at funding). Fall
  // back to the platform default when the row predates the column, so a
  // legacy/recovered game still runs under a sane clock.
  let timeControlSeconds = DEFAULT_TIME_CONTROL_SECONDS;
  try {
    const match = await prisma.match.findUnique({
      where: { id: matchId },
      select: { timeControlSeconds: true }
    });
    if (match && Number.isInteger(match.timeControlSeconds) && match.timeControlSeconds > 0) {
      timeControlSeconds = match.timeControlSeconds;
    }
  } catch (err) {
    logger.warn({ err, matchId },
      'initializeGame: failed to load time control snapshot, using default');
  }

  const initialBoard = createInitialBoard();
  const boardHash = JSON.stringify([initialBoard, COLOR_WHITE]);
  const now = Date.now();
  
  const initialState = {
    player1: player1Id,
    player2: player2Id,
    currentTurn: COLOR_WHITE,
    currentTurnUserId: player1Id,
    board: JSON.stringify(initialBoard),
    status: 'in_progress',
    winnerId: '',
    stakeTier,
    moveCount: 0,
    version: 0,
    positionCounts: JSON.stringify({ [boardHash]: 1 }),
    consecutiveKingMoves: 0,
    lastMoveTs: now,
    deadlineAt: now + timeControlSeconds * 1000,
    timeControlSeconds
  };
  
  try {
    await redis.hset(matchKey, initialState);
    await redis.expire(matchKey, GAME_STATE_TTL);
    await redis.set(`user:${player1Id}:activeMatch`, matchId);
    await redis.set(`user:${player2Id}:activeMatch`, matchId);
    
    return {
      ...initialState,
      board: initialBoard,
      positionCounts: { [boardHash]: 1 },
      legalMoves: getLegalMoves(initialBoard, COLOR_WHITE)
    };
  } catch (err) {
    logger.error({ err, matchId }, 'Failed to initialize game state in Redis');
    throw err;
  }
};

export const handleResign = async (socket, payload) => {
  const userId = socket.user?.userId;
  if (!userId) return;

  const validated = validateMatchIdPayload(payload);
  if (!validated.ok) {
    socket.emit('error', { message: 'Invalid payload' });
    return;
  }
  const { matchId } = validated.data;

  let retries = 2;
  let success = false;

  while (retries >= 0 && !success) {
    try {
      const state = await getGameState(matchId);
      if (!state) {
        socket.emit('error', { message: 'Game not found' });
        return;
      }
      
      if (state.player1 !== userId && state.player2 !== userId) {
        socket.emit('error', { message: 'Not authorized' });
        return;
      }
      
      if (state.status !== 'in_progress') {
        socket.emit('error', { message: 'Game already ended' });
        return;
      }

      const opponentId = state.player1 === userId ? state.player2 : state.player1;

      // We execute the CAS script for resignation, which flips status to completed and sets winner.
      const resignTc = Number(state.timeControlSeconds) > 0
        ? state.timeControlSeconds
        : DEFAULT_TIME_CONTROL_SECONDS;
      await redis.eval(
        casScript,
        1,
        `match:${matchId}`,
        state.version,
        state.board,
        state.currentTurn,
        state.currentTurnUserId,
        state.moveCount,
        Date.now().toString(),
        state.positionCounts,
        state.consecutiveKingMoves,
        'completed',
        opponentId,
        '', // deadlineAt — no future deadline on an ended game
        resignTc.toString()
      );

      success = true;

      const io = getIO();
      io.to(`match:${matchId}`).emit('match_ended_resign', { winnerId: opponentId, resignedId: userId });
      
      // Call settleGame
      await settleGameWithRetry(matchId, opponentId, userId, 'resign');
    } catch (err) {
      if (err.message && err.message.includes('VERSION_MISMATCH')) {
        retries--;
        if (retries < 0) {
          socket.emit('error', { message: 'Server busy, resign failed' });
        }
      } else if (err.message && err.message.includes('GAME_NOT_FOUND')) {
        socket.emit('error', { message: 'Game already ended' });
        return;
      } else {
        logger.error({ err, matchId }, 'Error in handleResign');
        socket.emit('error', { message: 'Internal server error' });
        return;
      }
    }
  }
};

const validatePreconditions = (state, userId) => {
  if (!state) return 'game_already_ended';
  if (state.status !== 'in_progress') return 'game_not_in_progress';
  if (state.currentTurnUserId !== userId) return 'not_your_turn';
  return null;
};

const computeNextState = (state, from, to, nowMs = Date.now()) => {
  const board = JSON.parse(state.board);
  const legalMoves = getLegalMoves(board, state.currentTurn);
  
  const move = legalMoves.find(m => m.from === from && m.to === to);
  if (!move) return { error: 'illegal_move' };

  // applyMove returns { newBoard, captured, promoted } — never the bare array.
  const applyResult = applyMove(board, move);
  const newBoard = applyResult.newBoard;
  const nextTurn = state.currentTurn === COLOR_WHITE ? COLOR_BLACK : COLOR_WHITE;
  const nextTurnUserId = nextTurn === COLOR_WHITE ? state.player1 : state.player2;
  const moveCount = parseInt(state.moveCount, 10) + 1;
  
  let consecutiveKingMoves = parseInt(state.consecutiveKingMoves, 10);
  const pieceMoved = board[from - 1]; // from is 1-indexed
  if (isKing(pieceMoved) && (!move.capturedSquares || move.capturedSquares.length === 0)) {
    consecutiveKingMoves++;
  } else {
    consecutiveKingMoves = 0;
  }

  const positionCounts = JSON.parse(state.positionCounts);
  const newHash = JSON.stringify([newBoard, nextTurn]);
  positionCounts[newHash] = (positionCounts[newHash] || 0) + 1;

  const { ended, reason, winner } = checkGameEnd(newBoard, nextTurn, positionCounts, consecutiveKingMoves);
  let newStatus = 'in_progress';
  let winnerId = '';
  
  if (ended) {
    if (winner) {
      newStatus = 'completed';
      winnerId = winner === COLOR_WHITE ? state.player1 : state.player2;
    } else {
      newStatus = 'draw';
    }
  }

  // The next turn's clock opens when this move lands; an ended game carries
  // no deadline.
  const timeControlSeconds = state.timeControlSeconds && Number(state.timeControlSeconds) > 0
    ? Number(state.timeControlSeconds)
    : DEFAULT_TIME_CONTROL_SECONDS;
  const deadlineAt = newStatus === 'in_progress'
    ? String(nowMs + timeControlSeconds * 1000)
    : '';

  return { 
    newBoard, nextTurn, nextTurnUserId, moveCount, consecutiveKingMoves, 
    positionCounts, ended, reason, newStatus, winnerId, move, promoted: applyResult.promoted,
    deadlineAt, timeControlSeconds
  };
};

export const handleMoveAttempt = async (socket, payload) => {
  const userId = socket.user?.userId;
  if (!userId) return;

  const validated = validateMoveAttempt(payload);
  if (!validated.ok) {
    socket.emit('move_rejected', { reason: 'invalid_payload' });
    return;
  }
  const { matchId, from, to } = validated.data;

  let retries = 2;
  let success = false;

  while (retries >= 0 && !success) {
    try {
      const state = await getGameState(matchId);
      
      const preconditionError = validatePreconditions(state, userId);
      if (preconditionError) {
        socket.emit('move_rejected', { reason: preconditionError });
        return;
      }

      const nextState = computeNextState(state, from, to);
      if (nextState.error) {
        socket.emit('move_rejected', { reason: nextState.error });
        return;
      }

      const {
        newBoard, nextTurn, nextTurnUserId, moveCount, consecutiveKingMoves,
        positionCounts, ended, reason, newStatus, winnerId, move, promoted,
        deadlineAt, timeControlSeconds
      } = nextState;

      // Single clock read per attempt: the durable log and the live projection
      // must agree on the moment the turn clock opened.
      const nowMs = Date.now();

      // Expiry pre-check BEFORE durable acceptance: a move whose turn already
      // expired must not be persisted at all (no phantom log row). The CAS
      // script re-validates atomically, so even a deadline crossing between
      // here and the script resolves correctly via the catch below.
      const deadlineVal = Number(state.deadlineAt);
      if (newStatus === 'in_progress' && Number.isFinite(deadlineVal) && deadlineVal > 0) {
        const nowMsAuthoritative = await authoritativeNowMs();
        if (nowMsAuthoritative > deadlineVal) {
          refuseExpiredTurn(socket, matchId, state, userId);
          return;
        }
      }

      // The move is accepted durably BEFORE the live projection advances. The
      // move log is the source of truth and Redis is a replayable projection
      // of it, so an accepted move survives a crash or Redis loss in one
      // replayable history.
      const pieceMoved = JSON.parse(state.board)[from - 1];
      let persisted;
      try {
        persisted = await persistMatchMove({
          matchId,
          moveNumber: moveCount,
          playerId: userId,
          fromSquare: from,
          toSquare: to,
          capturedSquares: move.capturedSquares || [],
          isKingMove: isKing(pieceMoved),
          boardStateAfter: newBoard
        });
      } catch (err) {
        // Durable acceptance failed — nothing advanced, so the client can
        // safely retry the same move.
        socket.emit('move_rejected', { reason: 'persist_failed' });
        return;
      }

      if (persisted.alreadyExists) {
        // A previous delivery already recorded this exact move. If the
        // projection has advanced past it, this is a duplicate delivery of an
        // accepted move — idempotent, no second broadcast. Otherwise a process
        // died between the DB write and the projection apply; resume it below.
        const current = await getGameState(matchId);
        if (!current) {
          socket.emit('move_rejected', { reason: 'game_already_ended' });
          return;
        }
        if (parseInt(current.moveCount, 10) >= moveCount) {
          success = true;
          continue;
        }
      }

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
        timeControlSeconds.toString()
      );

      success = true;

      // First accepted live move advances the match lifecycle: READY -> IN_PLAY
      // (idempotent CAS; the startedAt stamp is written once). A retry on an
      // already-started match finds status IN_PLAY and is a no-op.
      if (moveCount === 0) {
        try {
          await transitionMatchWhere(prisma, matchId, ['READY'], 'IN_PLAY', {
            startedAt: new Date()
          });
        } catch (err) {
          // The move is already durable and Redis is already advanced; a failed
          // status flip is repaired by the next move or the reconciliation
          // sweep. Never reject the move over it.
          logger.warn({ err, matchId }, 'READY -> IN_PLAY transition skipped');
        }
      }

      // Emit to room — the board plus the match identity (matchId/version) a
      // client needs to reconcile state after a reconnect or a duplicate
      // delivery.
      const io = getIO();
      const nextLegalMoves = ended ? [] : getLegalMoves(newBoard, nextTurn);
      io.to(`match:${matchId}`).emit('move_applied', {
        matchId,
        version: String(parseInt(state.version, 10) + 1),
        from, to,
        captured: move.capturedSquares || [],
        promoted,
        nextTurn,
        gameEnded: ended,
        reason,
        legalMoves: nextLegalMoves,
        board: newBoard
      });

      // Settlement. The outcome evidence is durable by now: the final move hit
      // the log before the projection advanced and before settlement ran.
      if (ended) {
        if (newStatus === 'completed') {
          const loserId = winnerId === state.player1 ? state.player2 : state.player1;
          settleGameWithRetry(matchId, winnerId, loserId, reason);
        } else {
          settleGameDrawWithRetry(matchId, reason);
        }
      }
    } catch (err) {
      if (err.message && err.message.includes('VERSION_MISMATCH')) {
        retries--;
        if (retries < 0) {
          socket.emit('move_rejected', { reason: 'server_busy' });
        }
      } else if (err.message && err.message.includes('GAME_NOT_FOUND')) {
        socket.emit('move_rejected', { reason: 'game_already_ended' });
        return;
      } else if (err.message && err.message.includes('TURN_EXPIRED')) {
        // The clock expired in the window between the pre-check and the CAS —
        // an extremely narrow race against the sweep. Same refusal outcome.
        refuseExpiredTurn(socket, matchId, state, userId);
        return;
      } else {
        logger.error({ err, matchId }, 'Error in handleMoveAttempt');
        socket.emit('error', { message: 'Internal server error processing move' });
        return;
      }
    }
  }
};
