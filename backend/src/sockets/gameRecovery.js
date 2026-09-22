import redis from '../utils/redis.js';
import prisma from '../utils/db.js';
import logger from '../utils/logger.js';
import {
  createInitialBoard,
  getLegalMoves,
  applyMove,
  checkGameEnd,
  isKing,
  COLOR_WHITE,
  COLOR_BLACK
} from '../modules/engine/index.js';
import {
  DEFAULT_TIME_CONTROL_SECONDS,
  disconnectGraceMs,
  resolveDisconnectGraceMs
} from './timeControl.js';

const GAME_STATE_TTL = 24 * 60 * 60;
const LIVE_MATCH_STATUSES = ['IN_PLAY', 'ACTIVE'];
const SIDE_COLOR = { LIGHT: COLOR_WHITE, DARK: COLOR_BLACK };

// Replays the durable move log into the exact projection the live engine would
// hold: board, turn, threefold counts and the terminal outcome. Throws when a
// stored move does not replay cleanly so a corrupted log is never projected.
const replayDurableMoves = (rows) => {
  let board = createInitialBoard();
  let turn = COLOR_WHITE;
  let consecutiveKingMoves = 0;
  const positionCounts = { [JSON.stringify([board, turn])]: 1 };
  let ended = false;
  let reason = null;
  let winnerColor = null;

  for (const row of rows) {
    const legal = getLegalMoves(board, turn);
    const desired = Array.isArray(row.path) && row.path.length ? row.path : null;
    const move = desired
      ? legal.find((m) => m.from === row.fromSquare && m.to === row.toSquare
          && Array.isArray(m.path) && m.path.length === desired.length
          && m.path.every((sq, i) => sq === desired[i]))
      : legal.find((m) => m.from === row.fromSquare && m.to === row.toSquare);
    if (!move) throw new Error(`durable move ${row.moveNumber} does not replay`);

    const pieceMoved = board[row.fromSquare - 1];
    const applied = applyMove(board, move);
    board = applied.newBoard;
    turn = turn === COLOR_WHITE ? COLOR_BLACK : COLOR_WHITE;
    if (isKing(pieceMoved) && (!move.capturedSquares || move.capturedSquares.length === 0)) {
      consecutiveKingMoves++;
    } else {
      consecutiveKingMoves = 0;
    }
    const hash = JSON.stringify([board, turn]);
    positionCounts[hash] = (positionCounts[hash] || 0) + 1;
    const end = checkGameEnd(board, turn, positionCounts, consecutiveKingMoves);
    ended = Boolean(end.ended);
    reason = end.reason ?? null;
    winnerColor = end.winner ?? null;
  }

  return { board, turn, consecutiveKingMoves, positionCounts, ended, reason, winnerColor };
};

const buildProjection = ({ live, durable, match, rows }) => {
  const player1 = live?.player1 || match.playerLightId;
  const player2 = live?.player2 || match.playerDarkId;

  const replay = rows.length > 0 ? replayDurableMoves(rows) : null;
  const board = replay ? replay.board : (durable.boardState ?? createInitialBoard());
  const turn = replay ? replay.turn : (SIDE_COLOR[durable.currentTurn] || COLOR_WHITE);
  const moveCount = replay ? rows.length : durable.stateVersion;
  const positionCounts = replay
    ? replay.positionCounts
    : { [JSON.stringify([board, turn])]: 1 };
  const consecutiveKingMoves = replay ? replay.consecutiveKingMoves : 0;

  let status = 'in_progress';
  let winnerId = '';
  if (replay?.ended) {
    if (replay.winnerColor) {
      status = 'completed';
      winnerId = replay.winnerColor === COLOR_WHITE ? player1 : player2;
    } else {
      status = 'draw';
    }
  } else if (!LIVE_MATCH_STATUSES.includes(match.status) && rows.length === 0) {
    status = 'completed';
    winnerId = match.winnerId || '';
  }

  const timeControlSeconds = Number(match.timeControlSeconds) > 0
    ? Number(match.timeControlSeconds)
    : (Number(live?.timeControlSeconds) > 0
        ? Number(live.timeControlSeconds)
        : DEFAULT_TIME_CONTROL_SECONDS);
  const turnStartedAtServer = durable.turnStartedAt
    ? durable.turnStartedAt.getTime()
    : (Number(live?.turnStartedAtServer) > 0 ? Number(live.turnStartedAtServer) : null);
  const deadlineAt = status === 'in_progress' && turnStartedAtServer
    ? String(turnStartedAtServer + timeControlSeconds * 1000)
    : '';

  return {
    player1,
    player2,
    currentTurn: turn,
    currentTurnUserId: turn === COLOR_WHITE ? player1 : player2,
    board: JSON.stringify(board),
    status,
    winnerId,
    stakeTier: live?.stakeTier || 'AMATEUR',
    moveCount: String(moveCount),
    version: String(moveCount),
    positionCounts: JSON.stringify(positionCounts),
    consecutiveKingMoves: String(consecutiveKingMoves),
    lastMoveTs: String(Date.now()),
    deadlineAt,
    timeControlSeconds: String(timeControlSeconds),
    turnStartedAtServer: turnStartedAtServer ? String(turnStartedAtServer) : '',
    disconnectGraceMs: String(resolveDisconnectGraceMs(live))
  };
};

// Rebuilds and persists the live projection from the durable log. Used when the
// Redis projection is missing or behind the durable state version.
export const rebuildProjectionFromDurable = async (matchId, { durable = null, live = null } = {}) => {
  const durableState = durable || await prisma.matchGameState.findUnique({ where: { matchId } });
  if (!durableState) return live;

  const [rows, match] = await Promise.all([
    prisma.matchMove.findMany({ where: { matchId }, orderBy: { moveNumber: 'asc' } }),
    prisma.match.findUnique({
      where: { id: matchId },
      select: {
        playerLightId: true,
        playerDarkId: true,
        status: true,
        winnerId: true,
        timeControlSeconds: true
      }
    })
  ]);
  if (!match) return live;

  const projection = buildProjection({ live, durable: durableState, match, rows });
  await redis.hset(`match:${matchId}`, projection);
  await redis.expire(`match:${matchId}`, GAME_STATE_TTL);
  return projection;
};

// The live projection is authoritative only while it is at least as advanced as
// the durable state version. Otherwise it is rebuilt from the durable log.
export const reconcileRedisWithDurable = async (matchId) => {
  const live = await redis.hgetall(`match:${matchId}`);
  const hasLive = live && Object.keys(live).length > 0;

  let durable = null;
  try {
    durable = await prisma.matchGameState.findUnique({ where: { matchId } });
  } catch (err) {
    logger.warn({ err, matchId }, 'Reconcile: durable state read failed');
    return hasLive ? live : null;
  }

  if (!durable) return hasLive ? live : null;
  if (hasLive && Number(live.version) >= durable.stateVersion) return live;

  try {
    return await rebuildProjectionFromDurable(matchId, { durable, live });
  } catch (err) {
    logger.error({ err, matchId }, 'Reconcile: durable log failed to replay; serving live state');
    return hasLive ? live : null;
  }
};

// A restart is a server incident: re-arm every pending disconnect with a fresh
// grace window so an outage can never silently forfeit a player. The turn clock
// stays authoritative and untouched.
const rearmPendingDisconnects = async () => {
  const entries = await redis.zrange('disconnects', 0, -1);
  for (const entry of entries) {
    const matchId = entry.split(':')[0];
    const state = await redis.hgetall(`match:${matchId}`);
    if (!state || Object.keys(state).length === 0) {
      await redis.zrem('disconnects', entry);
      continue;
    }
    await redis.zadd('disconnects', Date.now() + resolveDisconnectGraceMs(state), entry);
  }
  return entries.length;
};

// Boot recovery: rehydrate every live match's projection and participant
// pointers from durable state, then clear stale pointers for finished matches.
// A live match that the durable replay cannot account for (Redis fully lost
// before any move was written, or a crash between the durable FUNDED/READY ->
// IN_PLAY flip and the Redis upgrade) is re-staged server-authoritatively via
// gameManager's idempotent startMatchGame. The import is lazy (dynamic) because
// gameManager pulls the live game protocol and would otherwise create a
// circular static dependency with this recovery module.
export const recoverLiveGames = async ({ limit = 200 } = {}) => {
  const matches = await prisma.match.findMany({
    where: { status: { in: LIVE_MATCH_STATUSES } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true, status: true, timeControlSeconds: true }
  });

  let recovered = 0;
  let restaged = 0;
  for (const row of matches) {
    try {
      let state = await reconcileRedisWithDurable(row.id);

      if (state && state.status === 'ready_pending') {
        // Staged but never started (crash between the DB flip and the Redis
        // upgrade, or the sweep raced) — start it with a live clock.
        const { startMatchGame } = await import('./gameManager.js');
        const started = await startMatchGame(row.id);
        state = started.state ?? state;
        restaged++;
        recovered++;
      } else if (!state) {
        // Redis projection gone and no durable log to replay — re-stage the
        // live match with a fresh clock so the players can rejoin.
        const { startMatchGame } = await import('./gameManager.js');
        const started = await startMatchGame(row.id);
        state = started.state;
        restaged++;
      }

      if (state) {
        await redis.set(`user:${state.player1}:activeMatch`, row.id);
        await redis.set(`user:${state.player2}:activeMatch`, row.id);
        recovered++;
      }
    } catch (err) {
      logger.error({ err, matchId: row.id }, 'Boot recovery failed for match');
    }
  }

  const rearmed = await rearmPendingDisconnects();
  logger.info({ scanned: matches.length, recovered, restaged, rearmed }, 'Game state recovery complete');
  return { scanned: matches.length, recovered, restaged, rearmed };
};

export const startGameRecovery = () => {
  recoverLiveGames().catch((err) => {
    logger.error({ err }, 'Boot game state recovery failed');
  });
};
