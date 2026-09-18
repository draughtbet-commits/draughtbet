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
    if (!matchId) return;

    const state = await getGameState(matchId);
    const grace = resolveDisconnectGraceMs(state);

    await redis.zadd('disconnects', Date.now() + grace, `${matchId}:${userId}`);

    socket.to(`match:${matchId}`).emit('opponent_disconnected', {
      userId,
      gracePeriodMs: grace
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
      `/match/${matchId}`
    );

    logger.info({ userId, matchId, graceMs: grace },
      'Player disconnected, started grace period and sent warning');
  } catch (err) {
    logger.error({ err, userId }, 'Error handling disconnect');
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
      socket.to(`match:${matchId}`).emit('opponent_reconnected', { userId });
      await recordConnectionEvent({ matchId, userId, state: 'RECONNECTED', socket });
    }
    logger.info({ userId, matchId }, 'Player reconnected and joined match room');
  } catch (err) {
    logger.error({ err, userId, matchId }, 'Error handling join match');
    socket.emit('error', { message: 'Failed to join match' });
  }
}
