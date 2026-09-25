import redis from '../utils/redis.js';
import prisma from '../utils/db.js';
import { getIO } from './index.js';
import {
  authoritativeNowMs,
  getActiveGameForUser,
  getGameState
} from './gameManager.js';
import { reconcileRedisWithDurable } from './gameRecovery.js';
import { getLegalMoves } from '../modules/engine/index.js';
import { buildStatePayload } from './gameProtocol.js';
import { validateMatchIdPayload } from './payloadGuard.js';
import { resolveDisconnectGraceMs } from './timeControl.js';
import { recordConnectionEvent, recordGameEvent } from './connectionEvidence.js';
import logger from '../utils/logger.js';
import { NotificationService } from '../modules/notification/service.js';
import { isLiveStatus } from '../modules/match/service.js';

// Room budget per connection: every socket owns its personal `user:<id>` room,
// so this is the cap on the personal room plus match rooms.
const MAX_ROOMS_PER_CONNECTION = 5;

// Records a participant's presence on the live projection so `match.state`
// exposes `connection` states synchronously. Authority remains the `disconnects`
// zset (consumed by the disconnect sweep); this is a best-effort projection.
const recordPresence = async (matchId, state, userId, status, graceEndsAt = null) => {
  const side = state && state.player1 === userId ? 'LIGHT' : state && state.player2 === userId ? 'DARK' : null;
  if (!side) return;
  await writePresence(matchId, side, userId, status, graceEndsAt);
};

const writePresence = async (matchId, side, userId, status, graceEndsAt = null) => {
  const field = `conn${side}`;
  const value = status === 'disconnected'
    ? JSON.stringify({ status, graceEndsAt: graceEndsAt ?? null })
    : JSON.stringify({ status });
  try {
    await redis.hset(`match:${matchId}`, { [field]: value });
  } catch (err) {
    logger.warn({ err, matchId, userId }, 'Record presence failed');
  }
};

export async function handleDisconnect(socket) {
  const userId = socket.user?.userId;
  if (!userId) return;

  try {
    // Only the last socket for this user marks them disconnected; closing a
    // second tab must not start the grace timer or warn the opponent.
    try {
      const remaining = await getIO().in(`user:${userId}`).fetchSockets();
      if (remaining.some((s) => s.user?.userId === userId)) return;
    } catch (err) {
      logger.warn({ err, userId }, 'Disconnect: socket liveness check failed');
    }

    const matchId = await getActiveGameForUser(userId);
    const preStart = await isPreStartMatch(matchId);
    if (preStart) {
      // Pre-start (FUNDED/READY) disconnect: the match is not live yet, so the
      // opponent is told directly about the dropped connection so the app can
      // surface the disconnected-before-start state. Note the match may hold an
      // activeMatch pointer even before play starts (the holding projection is
      // reserved at funding), so this branch keys on durable status instead of
      // pointer absence.
      await notifyPreStartDisconnect(userId, socket);
      return;
    }

    const state = await getGameState(matchId);
    const grace = resolveDisconnectGraceMs(state);

    await redis.zadd('disconnects', Date.now() + grace, `${matchId}:${userId}`);

    await recordPresence(matchId, state, userId, 'disconnected', Date.now() + grace);

    socket.to(`match:${matchId}`).emit('opponent_disconnected', {
      userId,
      gracePeriodMs: grace
    });
    socket.to(`match:${matchId}`).emit('opponent.connection', {
      userId,
      status: 'disconnected',
      graceEndsAt: Date.now() + grace
    });

    await recordConnectionEvent({ matchId, userId, state: 'DISCONNECTED', socket });
    await recordGameEvent({
      matchId,
      playerId: userId,
      type: 'DISCONNECT',
      payload: { graceMs: grace }
    });

    await NotificationService.create(
      userId,
      'DISCONNECT_WARNING',
      'Connection Lost',
      `You have ${Math.round(grace / 1000)} seconds to reconnect before forfeiting your match.`,
      `/match/${matchId}`,
      matchId
    );

    logger.info({ userId, matchId, graceMs: grace },
      'Player disconnected, started grace period and sent warning');
  } catch (err) {
    logger.error({ err, userId }, 'Error handling disconnect');
  }
}

/**
 * A participant's socket dropped while the match is still pre-play (FUNDED or
 * READY, no live game). The opponent gets a direct presence ping the same way a
 * live disconnect pings the match room, so the parked app can surface the
 * disconnected-before-start state without polling. Best-effort: the match may
 * have been concurrently released.
 */
/**
 * True when the user's active match is still pre-play (FUNDED/READY). The
 * holding projection reserves an activeMatch pointer at funding, so a live
 * disconnect is distinguished from a pre-start one by the durable status.
 */
async function isPreStartMatch(matchId) {
  if (!matchId) return true;
  try {
    const match = await prisma.match.findUnique({
      where: { id: matchId },
      select: { status: true }
    });
    return !!match && (match.status === 'FUNDED' || match.status === 'READY');
  } catch (err) {
    logger.warn({ err, matchId }, 'isPreStartMatch: status lookup failed');
    return false;
  }
}

async function notifyPreStartDisconnect(userId, socket) {
  try {
    const match = await prisma.match.findFirst({
      where: {
        status: { in: ['FUNDED', 'READY'] },
        OR: [{ playerLightId: userId }, { playerDarkId: userId }]
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        playerLightId: true,
        playerDarkId: true
      }
    });
    if (!match) return;

    const opponentId =
      match.playerLightId === userId ? match.playerDarkId : match.playerLightId;
    await writePresence(match.id, match.playerLightId === userId ? 'LIGHT' : 'DARK', userId, 'disconnected');

    socket.to(`user:${opponentId}`).emit('opponent_disconnected', {
      userId,
      preStart: true
    });
    socket.to(`user:${opponentId}`).emit('opponent.connection', {
      userId,
      status: 'disconnected',
      preStart: true
    });
    logger.info({ userId, matchId: match.id }, 'Pre-start opponent disconnect notified');
  } catch (err) {
    logger.warn({ err, userId }, 'Pre-start disconnect notify failed');
  }
}

export async function handleJoinMatch(socket, payload) {
  const userId = socket.user?.userId;
  if (!userId) return;

  const validated = validateMatchIdPayload(payload);
  if (!validated.ok) {
    socket.emit('error', { message: 'Invalid payload' });
    return;
  }
  const { matchId } = validated.data;

  try {
    // AUTHORIZE BEFORE any room/presence mutation: a third account must
    // receive neither room membership nor game state, and cannot spoof a
    // reconnection notification. Knowledge of a match id is not authorization.
    const match = await prisma.match.findUnique({
      where: { id: matchId },
      select: { status: true, playerLightId: true, playerDarkId: true }
    });

    if (!match) {
      socket.emit('error', { message: 'Match not found' });
      return;
    }
    if (match.playerLightId !== userId && match.playerDarkId !== userId) {
      socket.emit('error', { message: 'Not a participant' });
      return;
    }

    // Limit per-connection rooms so one connection cannot hoard arbitrary rooms.
    if (socket.rooms.size >= MAX_ROOMS_PER_CONNECTION) {
      socket.emit('error', { message: 'Too many rooms' });
      return;
    }

    await redis.zrem('disconnects', `${matchId}:${userId}`);
    socket.join(`match:${matchId}`);

    // Reconcile the live projection against the durable log before serving it:
    // a restart or Redis loss must surface the canonical board, never a stale
    // or missing one.
    const state = await reconcileRedisWithDurable(matchId);
    if (!state) {
      socket.emit('error', { message: 'Game not found' });
      return;
    }

    const board = JSON.parse(state.board);
    const currentTurn = state.currentTurn;
    const legalMoves = getLegalMoves(board, currentTurn);
    const nowMs = await authoritativeNowMs();

    // Legacy `game_state` (raw Redis hash + legalMoves) plus the canonical
    // V2 `match.state` resync payload. The app migrates to the latter.
    socket.emit('game_state', {
      ...state,
      legalMoves
    });
    const canonical = buildStatePayload(matchId, state, nowMs);
    if (canonical) socket.emit('match.state', canonical);

    if (isLiveStatus(match.status)) {
      await recordPresence(matchId, state, userId, 'connected');
      socket.to(`match:${matchId}`).emit('opponent_reconnected', { userId });
      socket.to(`match:${matchId}`).emit('opponent.connection', {
        userId,
        status: 'connected'
      });
      await recordConnectionEvent({ matchId, userId, state: 'RECONNECTED', socket });
    } else if (match.status === 'FUNDED' || match.status === 'READY') {
      // A participant can be present (socket attached to the match) before the
      // opening is live; record it so the lifecycle snapshot can say the
      // opponent is online even though the game_state projection may not exist.
      const side = match.playerLightId === userId ? 'LIGHT' : 'DARK';
      await writePresence(match.id, side, userId, 'connected');
      socket.to(`user:${userId === match.playerLightId ? match.playerDarkId : match.playerLightId}`)
        .emit('opponent.connection', { userId, status: 'connected', preStart: true });
    }
    logger.info({ userId, matchId }, 'Player reconnected and joined match room');
  } catch (err) {
    logger.error({ err, userId, matchId }, 'Error handling join match');
    socket.emit('error', { message: 'Failed to join match' });
  }
}
