import redis from '../utils/redis.js';
import logger from '../utils/logger.js';
import { validateClockSync, validateMatchIdPayload, validateMoveAttempt, validateMoveSubmit, validateReady, validateDrawOffer, validateDrawRespond } from './payloadGuard.js';
import { createInitialBoard, getLegalMoves, applyMove, checkGameEnd, COLOR_WHITE, COLOR_BLACK, isKing } from '../modules/engine/index.js';
import { settleGame, settleGameDraw, settleGameWithRetry, settleGameDrawWithRetry } from './settlement.js';
import {
  MOVE_ERROR,
  buildStatePayload,
  emitMoveRejected,
  emitMoveAccepted,
  SIDE_BY_COLOR
} from './gameProtocol.js';
import { getIO } from './index.js';
import {
  DEFAULT_TIME_CONTROL_SECONDS,
  TURN_EXPIRED_REASON,
  disconnectGraceMs,
  remainingMs
} from './timeControl.js';
import prisma from '../utils/db.js';
import { transitionMatchWhere, isLiveStatus } from '../modules/match/service.js';
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
  'timeControlSeconds',     ARGV[12],
  'turnStartedAtServer',    ARGV[13]
)
return 'OK'
`;

// Utility sleep function
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Authoritative server clock (Redis TIME), echoing the guard embedded in the
// CAS script so the pre-persist expiry check agrees with the atomic one.
export const authoritativeNowMs = async () => {
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
  emitMoveRejected(socket, MOVE_ERROR.TURN_EXPIRED);
  settleGameWithRetry(matchId, opponentId, userId, TURN_EXPIRED_REASON);
};

// Emits the canonical resync payload so a stale client can rebuild its board
// from the authoritative projection instead of guessing.
const emitResync = (socket, matchId, state, nowMs = null) => {
  const payload = buildStatePayload(matchId, state, nowMs);
  if (payload) socket.emit('match.state', payload);
};

// Rejects a move in both protocol shapes. When the authoritative state is
// known it is attached as a `match.state` resync — this is what makes a stale
// client recover deterministically rather than replay a dead move.
const rejectMove = (socket, matchId, state, code, extra = {}) => {
  emitMoveRejected(socket, code, extra);
  if (state) emitResync(socket, matchId, state);
};

// Idempotency: was this exact client move already accepted? Returns the stored
// row (used to replay the prior result without re-applying it) or null.
const findMoveByClientId = async (matchId, clientMoveId) => {
  if (!clientMoveId) return null;
  return prisma.matchMove.findUnique({
    where: { matchId_clientMoveId: { matchId, clientMoveId } }
  });
};

// Resolves the row behind a P2002 unique violation. A row carrying this exact
// clientMoveId is our own replayed move; otherwise the colliding row (if any)
// merely occupies our moveNumber and belongs to a competing move.
async function resolveUniqueConflict(moveData) {
  if (moveData.clientMoveId) {
    const mine = await prisma.matchMove.findUnique({
      where: {
        matchId_clientMoveId: {
          matchId: moveData.matchId,
          clientMoveId: moveData.clientMoveId
        }
      }
    });
    if (mine) return mine;
  }
  return prisma.matchMove.findUnique({
    where: {
      matchId_moveNumber: { matchId: moveData.matchId, moveNumber: moveData.moveNumber }
    }
  });
}

// Durable acceptance of a move. A move is not authoritative until this
// transaction commits: the immutable move row, the durable GameEvent (audit
// trail) and the MatchGameState projection are written atomically. The
// (matchId, moveNumber) and (matchId, clientMoveId) unique constraints make a
// concurrent or replayed submission unable to create a second row — the loser
// gets P2002 and is reported as `alreadyExists` with the colliding row
// (`existing`) so the caller can tell its own replay from a competing move.
// Throws when the write could not be completed after retries — in that case
// the move is NOT accepted.
async function persistAcceptedMove(moveData, durableState, retries = 3) {
  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const moveRow = await prisma.$transaction(async (tx) => {
        const created = await tx.matchMove.create({ data: moveData });
        await tx.gameEvent.create({
          data: {
            matchId: moveData.matchId,
            playerId: moveData.playerId,
            type: 'MOVE',
            payload: {
              moveId: created.id,
              clientMoveId: moveData.clientMoveId ?? null,
              moveNumber: moveData.moveNumber,
              from: moveData.fromSquare,
              to: moveData.toSquare,
              path: moveData.path ?? null,
              capturedSquares: moveData.capturedSquares ?? [],
              stateVersion: moveData.stateVersion ?? null
            }
          }
        });
        await tx.matchGameState.upsert({
          where: { matchId: moveData.matchId },
          create: { matchId: moveData.matchId, ...durableState },
          update: { ...durableState }
        });
        return created;
      });
      return { persisted: true, moveId: moveRow?.id ?? null };
    } catch (err) {
      lastErr = err;
      if (err && err.code === 'P2002') {
        // A P2002 may originate from either unique key. Resolve which row
        // actually collided so the caller can tell a replay of THIS move from a
        // competing move that merely holds the same moveNumber.
        return { alreadyExists: true, existing: await resolveUniqueConflict(moveData) };
      }
      logger.warn({ err, attempt, matchId: moveData.matchId, moveNumber: moveData.moveNumber },
        'Durable move persist failed, retrying');
      if (attempt < retries) await sleep(attempt * 100);
    }
  }
  logger.error({ err: lastErr, moveData },
    'CRITICAL: durable move persist failed after all retries. Move not accepted.');
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

/**
 * Stages (pending) or starts (pending=false) a funded match's Redis projection.
 *
 * Server-authoritative start: with `pending=false` the match lifecycle advances
 * FUNDED/READY -> IN_PLAY (idempotent CAS; the startedAt stamp is written once)
 * BEFORE the Redis projection goes live — chronological consistency and the
 * deadline sweep both rely on the DB flipping first, so a match can never be
 * forfeited while it is still legally pre-start. A pre-existing `ready_pending`
 * staging (from the activation path) is upgraded in place with a fresh turn
 * clock rather than clobbered.
 *
 * With `pending=true` (the two-player ready gate) the match stays FUNDED/READY and a
 * holding projection is written with status `ready_pending` and no running
 * clock: the turn-deadline sweep ignores it, pre-play cancel can still release
 * both stakes, and moves/resigns are refused until the game actually starts.
 */
export const initializeGame = async (matchId, player1Id, player2Id, stakeTier, { pending = false } = {}) => {
  const matchKey = `match:${matchId}`;

  // The game is staged before start as `ready_pending`; only an actual start
  // flips the durable lifecycle. A failed flip is repaired by the first move or
  // the reconciliation sweep, so never fail init over it.
  if (!pending) {
    try {
      await transitionMatchWhere(prisma, matchId, ['FUNDED', 'READY'], 'IN_PLAY', {
        startedAt: new Date()
      });
    } catch (err) {
      logger.warn({ err, matchId }, 'Match lifecycle FUNDED/READY -> IN_PLAY skipped');
    }
  }

  // Idempotent by construction: the durable GameOutbox record is the source of
  // truth here. If Redis already holds state for this match (a crash between
  // the Redis write and the start), do NOT clobber a possibly running game —
  // just guarantee the participant pointers and upgrade a pre-start staging to
  // live when a start is requested.
  if (await redis.exists(matchKey)) {
    await redis.set(`user:${player1Id}:activeMatch`, matchId);
    await redis.set(`user:${player2Id}:activeMatch`, matchId);
    const existing = await getGameState(matchId);

    if (!pending && existing && existing.status === 'ready_pending') {
      // A start on a staged-but-not-live projection: open the clock now. The
      // durability commit happened (or was retried) on the already-live path.
      const timeControlSeconds = Number(existing.timeControlSeconds) > 0
        ? Number(existing.timeControlSeconds)
        : DEFAULT_TIME_CONTROL_SECONDS;
      const now = Date.now();
      const upgraded = {
        ...existing,
        status: 'in_progress',
        deadlineAt: String(now + timeControlSeconds * 1000),
        turnStartedAtServer: String(now)
      };
      await redis.hset(matchKey, {
        status: upgraded.status,
        deadlineAt: upgraded.deadlineAt,
        turnStartedAtServer: upgraded.turnStartedAtServer
      });
      return {
        ...upgraded,
        board: JSON.parse(upgraded.board),
        positionCounts: JSON.parse(upgraded.positionCounts),
        legalMoves: getLegalMoves(JSON.parse(upgraded.board), upgraded.currentTurn),
        justStarted: true
      };
    }

    return { ...existing, justStarted: false };
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
  const live = !pending;

  const initialState = {
    player1: player1Id,
    player2: player2Id,
    currentTurn: COLOR_WHITE,
    currentTurnUserId: player1Id,
    board: JSON.stringify(initialBoard),
    // Directly staged (pre-start) projections stay non-live until both players
    // ready up; a start writes the authoritative live status with a live clock.
    status: live ? 'in_progress' : 'ready_pending',
    winnerId: '',
    stakeTier,
    moveCount: 0,
    version: 0,
    positionCounts: JSON.stringify({ [boardHash]: 1 }),
    consecutiveKingMoves: 0,
    lastMoveTs: now,
    deadlineAt: live ? String(now + timeControlSeconds * 1000) : '',
    timeControlSeconds,
    // Server-owned turn start and grace snapshot (client-clock independent);
    // a pre-start staging carries no running turn.
    turnStartedAtServer: live ? String(now) : '',
    disconnectGraceMs: disconnectGraceMs()
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
      legalMoves: live ? getLegalMoves(initialBoard, COLOR_WHITE) : [],
      justStarted: live
    };
  } catch (err) {
    logger.error({ err, matchId }, 'Failed to initialize game state in Redis');
    throw err;
  }
};

/**
 * Server-authoritative start of a funded match (the two-player ready gate). Both players
 * have signaled readiness; the match advances to IN_PLAY through
 * `initializeGame({ pending: false })` and the starting state is returned so the
 * caller can emit `game.started`. Idempotent: a retry on an already-started
 * match just returns the live state.
 */
export const startMatchGame = async (matchId) => {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: { playerLightId: true, playerDarkId: true, tier: true, startedAt: true, status: true }
  });
  if (!match) {
    const err = new Error(`Match not found: ${matchId}`);
    err.code = 'MATCH_NOT_FOUND';
    throw err;
  }
  // Safe to start from pre-play (FUNDED/READY) or already-live (idempotent
  // retry/recovery); never from a released/cancelled/settled row.
  if (!['FUNDED', 'READY', 'IN_PLAY', 'ACTIVE'].includes(match.status)) {
    const err = new Error(`Match cannot be started from status ${match.status}`);
    err.code = 'MATCH_NOT_STARTABLE';
    throw err;
  }
  const state = await initializeGame(matchId, match.playerLightId, match.playerDarkId, match.tier, { pending: false });
  const started = await prisma.match.findUnique({
    where: { id: matchId },
    select: { startedAt: true }
  });
  return {
    state,
    justStarted: Boolean(state?.justStarted),
    match: { ...match, startedAt: started?.startedAt ?? match.startedAt }
  };
};

// Broadcasts the canonical `match.state` to a match room when a projection
// exists (pendingDrawOffer / readiness / presence changes all flow through it).
const broadcastState = async (matchId, state, nowMs = null) => {
  const payload = buildStatePayload(matchId, state, nowMs);
  if (!payload) return;
  const io = getIO();
  io.to(`match:${matchId}`).emit('match.state', payload);
};

// Rejects a V2 action with a stable code, echoing it as both the code and a
// human-readable message on the shared `error` event (the documented pattern
// for non-move socket errors).
const emitActionError = (socket, code, extra = {}) => {
  socket.emit('error', { code, message: code, ...extra });
};

// Clears a stale pending draw offer once a fresh move lands (a move supersedes
// an unanswered offer). Best-effort; the settlement path clears the key anyway.
const clearPendingDrawOffer = async (matchId) => {
  try {
    await redis.hdel(`match:${matchId}`, 'pendingDrawOffer');
  } catch (e) {
    logger.warn({ e, matchId }, 'Pending draw offer clear failed');
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
        resignTc.toString(),
        '' // turnStartedAtServer — no running turn on an ended game
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

// Selects the legal move a client intended. Two distinct max-capture sequences
// can share the same from/to endpoints (the engine keeps every equal-length best
// path); when the client declares its `path` the exact-path match wins so a
// legal route can never be rejected as a mismatch with the first one found.
export const findLegalMove = (legalMoves, from, to, desiredPath = null) => {
  if (desiredPath && desiredPath.length > 1) {
    const byPath = legalMoves.find(
      (m) => m.from === from && m.to === to
        && Array.isArray(m.path) && m.path.length === desiredPath.length
        && m.path.every((sq, i) => sq === desiredPath[i])
    );
    if (byPath) return byPath;
  }
  return legalMoves.find((m) => m.from === from && m.to === to);
};

const computeNextState = (state, from, to, nowMs = Date.now(), desiredPath = null) => {
  const board = JSON.parse(state.board);
  const legalMoves = getLegalMoves(board, state.currentTurn);
  
  const move = findLegalMove(legalMoves, from, to, desiredPath);
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

// Emits the previous accepted result of a replayed client move to the sender
// only. The room already saw the move when it was first accepted, so a retry
// must never produce a second broadcast (which would double-apply client-side).
const replayAcceptedMove = (socket, matchId, current, existing, clientMoveId) => {
  socket.emit('move.accepted', {
    matchId,
    clientMoveId,
    version: String(current.version),
    stateVersion: Number(current.version),
    move: {
      from: existing.fromSquare,
      to: existing.toSquare,
      path: existing.path?.length ? existing.path : [existing.fromSquare, existing.toSquare],
      captured: existing.capturedSquares ?? [],
      promoted: existing.isKingMove
    },
    replayed: true
  });
  emitResync(socket, matchId, current);
};

// Canonical move pipeline shared by the V2 `move.submit` and the legacy
// `move_attempt` events. Durable-first: the move (plus its audit GameEvent and
// MatchGameState projection) commits before the live Redis projection advances.
const submitMove = async (socket, move) => {
  const userId = socket.user?.userId;
  if (!userId) return;

  const { matchId, from, clientMoveId = null, expectedStateVersion } = move;
  const to = move.to ?? (move.path ? move.path[move.path.length - 1] : undefined);

  let retries = 2;
  let success = false;

  while (retries >= 0 && !success) {
    // Declared outside the try so the catch below can attach the authoritative
    // state to a resync-capable rejection (server_busy / game_already_ended /
    // turn_expired) instead of throwing a ReferenceError.
    let state = null;
    try {
      state = await getGameState(matchId);

      // Idempotency check FIRST: a replayed client move must return the prior
      // result without touching the engine, the log or the projection. A null
      // clientMoveId (legacy) skips straight through.
      const existing = await findMoveByClientId(matchId, clientMoveId);
      if (existing) {
        const current = await getGameState(matchId);
        if (current && Number.parseInt(current.moveCount, 10) >= existing.moveNumber) {
          replayAcceptedMove(socket, matchId, current, existing, clientMoveId);
          return;
        }
        // Persisted but never projected (crash between commit and CAS) — fall
        // through and resume applying the same move.
      }

      const preconditionError = validatePreconditions(state, userId);
      if (preconditionError) {
        rejectMove(socket, matchId, state, preconditionError);
        return;
      }

      // Staleness gate: the client declares the version it acted on. Once the
      // authoritative projection has moved, the move is refused and a canonical
      // resync is pushed so the client rebuilds instead of retrying blindly.
      if (expectedStateVersion !== undefined && Number(state.version) !== Number(expectedStateVersion)) {
        rejectMove(socket, matchId, state, MOVE_ERROR.STALE_STATE, {
          expectedStateVersion,
          currentVersion: Number(state.version)
        });
        return;
      }

      const nextState = computeNextState(state, from, to, Date.now(), move.path ?? null);
      if (nextState.error) {
        rejectMove(socket, matchId, state, nextState.error);
        return;
      }

      // Full-capture validation: when the client sends its intended path it
      // must match the engine's canonical path exactly, so an ambiguous
      // multi-capture can never be silently reinterpreted.
      if (move.path) {
        const canonical = nextState.move.path ?? [from, to];
        const pathMismatch = canonical.length !== move.path.length
          || canonical.some((sq, i) => sq !== move.path[i]);
        if (pathMismatch) {
          rejectMove(socket, matchId, state, MOVE_ERROR.ILLEGAL_MOVE, { reason: 'path_mismatch' });
          return;
        }
      }

      const {
        newBoard, nextTurn, nextTurnUserId, moveCount, consecutiveKingMoves,
        positionCounts, ended, reason, newStatus, winnerId, move: legalMove, promoted,
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
      const nextVersion = Number.parseInt(state.version, 10) + 1;
      const canonicalPath = move.path ?? legalMove.path ?? [from, to];
      const captured = legalMove.capturedSquares || [];

      let persisted;
      try {
        persisted = await persistAcceptedMove(
          {
            matchId,
            moveNumber: moveCount,
            playerId: userId,
            fromSquare: from,
            toSquare: to,
            capturedSquares: captured,
            isKingMove: isKing(pieceMoved),
            boardStateAfter: newBoard,
            clientMoveId,
            path: canonicalPath,
            stateVersion: expectedStateVersion ?? Number(state.version)
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
      } catch (err) {
        // Durable acceptance failed — nothing advanced, so the client can
        // safely retry the same move.
        rejectMove(socket, matchId, state, MOVE_ERROR.PERSIST_FAILED);
        return;
      }

      if (persisted.alreadyExists) {
        const existing = persisted.existing ?? null;

        // Only a row carrying this exact idempotency key (or, for legacy moves,
        // the same from/to/captured) is a replay of THIS move. A row that
        // merely occupies our moveNumber belongs to a competing move: this
        // submission lost the race and was never applied, so it must be refused
        // with a resync rather than falsely reported as accepted.
        const sameMove = clientMoveId != null
          ? existing?.clientMoveId === clientMoveId
          : Boolean(
              existing
              && existing.fromSquare === from
              && existing.toSquare === to
              && JSON.stringify(existing.capturedSquares ?? []) === JSON.stringify(captured)
            );

        if (!sameMove) {
          rejectMove(socket, matchId, await getGameState(matchId), MOVE_ERROR.DUPLICATE_MOVE);
          return;
        }

        // A previous delivery already recorded this exact move. If the
        // projection has advanced past it, this is a duplicate delivery of an
        // accepted move — idempotent, no second broadcast. Otherwise a process
        // died between the DB write and the projection apply; resume it below.
        const current = await getGameState(matchId);
        if (!current) {
          rejectMove(socket, matchId, null, MOVE_ERROR.GAME_NOT_FOUND);
          return;
        }
        if (Number.parseInt(current.moveCount, 10) >= moveCount) {
          replayAcceptedMove(socket, matchId, current, {
            fromSquare: from,
            toSquare: to,
            path: canonicalPath,
            capturedSquares: captured,
            isKingMove: isKing(pieceMoved)
          }, clientMoveId);
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
        timeControlSeconds.toString(),
        // The next turn's official start is the same server instant that opened
        // its deadline; an ended game carries no running turn.
        newStatus === 'in_progress' ? nowMs.toString() : ''
      );

      success = true;

      // A landed move supersedes any unanswered draw offer — the offer only
      // spans the window before the game state changed (best-effort clear).
      await clearPendingDrawOffer(matchId);

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

      // Emit to room — legacy `move_applied` plus the V2 `move.accepted`, both
      // carrying the match identity (matchId/version) a client needs to
      // reconcile after a reconnect or a duplicate delivery.
      const io = getIO();
      const nextLegalMoves = ended ? [] : getLegalMoves(newBoard, nextTurn);
      emitMoveAccepted(io, matchId, {
        clientMoveId,
        move: {
          from,
          to,
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
          remainingMs: newStatus === 'in_progress' ? remainingMs(deadlineAt, nowMs) : null
        }
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
          rejectMove(socket, matchId, state, MOVE_ERROR.SERVER_BUSY);
        }
      } else if (err.message && err.message.includes('GAME_NOT_FOUND')) {
        rejectMove(socket, matchId, state, MOVE_ERROR.GAME_NOT_FOUND);
        return;
      } else if (err.message && err.message.includes('TURN_EXPIRED')) {
        // The clock expired in the window between the pre-check and the CAS —
        // an extremely narrow race against the sweep. Same refusal outcome.
        refuseExpiredTurn(socket, matchId, state, userId);
        return;
      } else {
        logger.error({ err, matchId }, 'Error in move submit');
        socket.emit('error', { message: 'Internal server error processing move' });
        return;
      }
    }
  }
};

// V2 entry point. Required idempotency key + optional expected state version.
export const handleMoveSubmit = async (socket, payload) => {
  const validated = validateMoveSubmit(payload);
  if (!validated.ok) {
    emitMoveRejected(socket, MOVE_ERROR.INVALID_PAYLOAD);
    return;
  }
  const { matchId, from, to, path, clientMoveId, expectedStateVersion } = validated.data;
  await submitMove(socket, { matchId, from, to, path, clientMoveId, expectedStateVersion });
};

// Legacy compatibility adapter. The deployed Flutter client emits `move_attempt`
// with only { matchId, from, to } and no version/idempotency key; it keeps
// working (no path validation, no staleness gate) while the app migrates.
export const handleMoveAttempt = async (socket, payload) => {
  const validated = validateMoveAttempt(payload);
  if (!validated.ok) {
    emitMoveRejected(socket, MOVE_ERROR.INVALID_PAYLOAD);
    return;
  }
  const { matchId, from, to } = validated.data;
  await submitMove(socket, { matchId, from, to, path: undefined, clientMoveId: null });
};

// Official clock sync. Answers with the server clock so a client can compute a
// skew offset and render the authoritative remaining time; never trusts a
// client-provided time.
export const handleClockSync = async (socket, payload) => {
  const userId = socket.user?.userId;
  if (!userId) return;

  const validated = validateClockSync(payload);
  if (!validated.ok) {
    socket.emit('error', { message: 'Invalid payload' });
    return;
  }
  const { matchId, clientSentAt } = validated.data;

  const state = await getGameState(matchId);
  if (!state) {
    socket.emit('error', { message: 'Game not found' });
    return;
  }
  if (state.player1 !== userId && state.player2 !== userId) {
    socket.emit('error', { message: 'Not authorized' });
    return;
  }

  const nowMs = await authoritativeNowMs();
  const deadlineAt = Number(state.deadlineAt) > 0 ? Number(state.deadlineAt) : null;
  socket.emit('clock.sync', {
    matchId,
    serverNowMs: nowMs,
    clientSentAt: clientSentAt ?? null,
    version: String(state.version ?? '0'),
    status: state.status || 'in_progress',
    currentTurn: state.currentTurn ?? null,
    currentTurnUserId: state.currentTurnUserId ?? null,
    turnStartedAtServer: Number(state.turnStartedAtServer) > 0
      ? Number(state.turnStartedAtServer)
      : null,
    deadlineAt,
    timeControlSeconds: Number(state.timeControlSeconds) > 0
      ? Number(state.timeControlSeconds)
      : null,
    remainingMs: remainingMs(deadlineAt, nowMs)
  });
};

/**
 * `player.ready`. A participant confirms readiness on the socket. Once
 * BOTH participants are ready the match is started (IN_PLAY with a live clock)
 * and exactly one `game.started` is broadcast to the room. Readiness is
 * recorded on the match projection so `match.state` exposes it; the durable
 * Match status is aligned to READY once the first participant readies (and the
 * REST /matches/:id/ready from WS4 is compatible — it simply sets the same
 * READY marker; the actual start still waits for both socket signals).
 */
export const handlePlayerReady = async (socket, payload) => {
  const userId = socket.user?.userId;
  if (!userId) return;

  const validated = validateReady(payload);
  if (!validated.ok) {
    emitActionError(socket, 'invalid_payload');
    return;
  }
  const { matchId } = validated.data;

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: { id: true, status: true, playerLightId: true, playerDarkId: true }
  });
  if (!match) {
    emitActionError(socket, 'match_not_found');
    return;
  }
  if (match.playerLightId !== userId && match.playerDarkId !== userId) {
    emitActionError(socket, 'not_authorized');
    return;
  }

  const stateUpdater = async () => {
    if (!isLiveStatus(match.status)) {
      // First readiness flips FUNDED -> READY (durable); a READY retry is a no-op.
      try {
        await transitionMatchWhere(prisma, matchId, ['FUNDED'], 'READY');
      } catch (err) {
        logger.warn({ err, matchId }, 'FUNDED -> READY transition skipped');
      }
    }
  };
  await stateUpdater();

  const side = match.playerLightId === userId ? 'LIGHT' : 'DARK';
  const readyKey = side === 'LIGHT' ? 'readyLight' : 'readyDark';
  const state = await getGameState(matchId);
  if (!state) {
    // No projection yet (Redis loss or the activation staging was never
    // processed): recreate the holding projection before recording readiness.
    try {
      await initializeGame(matchId, match.playerLightId, match.playerDarkId, match.tier, { pending: true });
    } catch (err) {
      logger.warn({ err, matchId }, 'player.ready: holding projection recreate failed');
    }
  }
  await redis.hset(`match:${matchId}`, { [readyKey]: String(Date.now()) });
  const refreshed = await getGameState(matchId);

  const otherReady = refreshed && refreshed[side === 'LIGHT' ? 'readyDark' : 'readyLight'];
  if (!otherReady) {
    await broadcastState(matchId, refreshed);
    return;
  }

  // Both players are ready: server-authoritative start + a single game.started.
  const { state: started, match: startedMatch, justStarted } = await startMatchGame(matchId);
  const clock = {
    deadlineAt: Number(started.deadlineAt) > 0 ? Number(started.deadlineAt) : null,
    turnStartedAtServer: Number(started.turnStartedAtServer) > 0
      ? Number(started.turnStartedAtServer)
      : null,
    timeControlSeconds: Number(started.timeControlSeconds) > 0
      ? Number(started.timeControlSeconds)
      : null,
    serverNowMs: Date.now()
  };
  const io = getIO();
  if (justStarted) {
    io.to(`match:${matchId}`).emit('game.started', {
      matchId,
      stateVersion: Number(started.version ?? '0'),
      startedAt: startedMatch?.startedAt ? startedMatch.startedAt.getTime() : Date.now(),
      board: typeof started.board === 'string' ? JSON.parse(started.board) : started.board,
      clocks: clock
    });
  }
  await broadcastState(matchId, started);
};

/**
 * `draw.offer {matchId, actionId, expectedStateVersion}`. Only the
 * current-turn participant may offer, at most one offer may be pending per
 * match, and a declared state version is validated against the authoritative
 * projection. The offer is stored in the match state (surfaced through
 * `match.state.pendingDrawOffer`) and replaced/cleared on a later move.
 */
export const handleDrawOffer = async (socket, payload) => {
  const userId = socket.user?.userId;
  if (!userId) return;

  const validated = validateDrawOffer(payload);
  if (!validated.ok) {
    emitActionError(socket, 'invalid_payload');
    return;
  }
  const { matchId, actionId, expectedStateVersion } = validated.data;

  const state = await getGameState(matchId);
  if (!state) {
    emitActionError(socket, 'game_already_ended');
    return;
  }
  if (state.player1 !== userId && state.player2 !== userId) {
    emitActionError(socket, 'not_authorized');
    return;
  }
  if (state.status !== 'in_progress') {
    emitActionError(socket, 'game_not_in_progress');
    return;
  }
  if (expectedStateVersion !== undefined && Number(state.version) !== Number(expectedStateVersion)) {
    emitActionError(socket, 'stale_state', {
      expectedStateVersion,
      currentVersion: Number(state.version)
    });
    emitResync(socket, matchId, state);
    return;
  }
  if (state.currentTurnUserId !== userId) {
    emitActionError(socket, 'not_your_turn');
    return;
  }
  if (state.pendingDrawOffer) {
    emitActionError(socket, 'draw_already_offered');
    return;
  }

  const offer = {
    offerId: `draw_offer_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    offeredByUserId: userId,
    actionId: actionId ?? null,
    offeredAt: Date.now(),
    expectedStateVersion: expectedStateVersion ?? Number(state.version)
  };
  await redis.hset(`match:${matchId}`, { pendingDrawOffer: JSON.stringify(offer) });

  const refreshed = await getGameState(matchId);
  await broadcastState(matchId, refreshed);
};

/**
 * `draw.respond {matchId, actionId, offerId, response}`. Only the
 * intended opponent may answer a pending offer. Accept → terminal draw via the
 * existing settlement path (match_ended + match.finished + settlement.completed
 * and refunds); decline → the offer is cleared and the match continues.
 */
export const handleDrawRespond = async (socket, payload) => {
  const userId = socket.user?.userId;
  if (!userId) return;

  const validated = validateDrawRespond(payload);
  if (!validated.ok) {
    emitActionError(socket, 'invalid_payload');
    return;
  }
  const { matchId, offerId, response } = validated.data;

  const state = await getGameState(matchId);
  if (!state) {
    emitActionError(socket, 'game_already_ended');
    return;
  }
  if (state.player1 !== userId && state.player2 !== userId) {
    emitActionError(socket, 'not_authorized');
    return;
  }
  if (state.status !== 'in_progress') {
    emitActionError(socket, 'game_not_in_progress');
    return;
  }

  let offer = null;
  if (state.pendingDrawOffer) {
    try {
      offer = JSON.parse(state.pendingDrawOffer);
    } catch {
      offer = null;
    }
  }
  if (!offer || offer.offerId !== offerId) {
    emitActionError(socket, 'draw_offer_not_found');
    return;
  }
  if (offer.offeredByUserId === userId) {
    emitActionError(socket, 'cannot_respond_to_own_offer');
    return;
  }

  await clearPendingDrawOffer(matchId);

  if (response === 'accept') {
    // Terminal draw — the settlement layer refunds both stakes and emits the
    // terminal + settlement events; its cleanup clears the projection.
    await settleGameDrawWithRetry(matchId, 'mutual_draw');
    return;
  }

  const refreshed = await getGameState(matchId);
  await broadcastState(matchId, refreshed);
};
