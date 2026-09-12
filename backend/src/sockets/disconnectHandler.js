import redis from '../utils/redis.js';
import prisma from '../utils/db.js';
import { getIO } from './index.js';
import { getActiveGameForUser, getGameState } from './gameManager.js';
import { getLegalMoves } from '../modules/engine/index.js';
import { validateMatchIdPayload } from './payloadGuard.js';
import logger from '../utils/logger.js';
import { NotificationService } from '../modules/notification/service.js';

// Room budget per connection: every socket owns its personal `user:<id>` room,
// so this is the cap on the personal room plus match rooms.
const MAX_ROOMS_PER_CONNECTION = 5;

export async function handleDisconnect(socket) {
  const userId = socket.user?.userId;
  if (!userId) return;

  try {
    // 1. Look up active game for this user
    const matchId = await getActiveGameForUser(userId);
    if (!matchId) return;

    // 2. Add to sorted set: member = "matchId:userId", score = expiryTimestamp
    await redis.zadd('disconnects', Date.now() + 60000, `${matchId}:${userId}`);

    // 3. Notify opponent
    socket.to(`match:${matchId}`).emit('opponent_disconnected', { userId, gracePeriodMs: 60000 });
    
    // 4. Send push notification warning
    await NotificationService.create(
      userId,
      'DISCONNECT_WARNING',
      'Connection Lost',
      'You have 60 seconds to reconnect before forfeiting your match.',
      `/match/${matchId}`
    );
    
    logger.info({ userId, matchId }, 'Player disconnected, started 60s grace period and sent warning');
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
    // AUTHORIZE BEFORE any room/presence mutation (S04): a third account must
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

    // 1. Remove from sorted set (drop the 60s grace marker)
    await redis.zrem('disconnects', `${matchId}:${userId}`);

    // 2. Rejoin Socket.IO room
    socket.join(`match:${matchId}`);

    // 3. Send current game state
    const state = await getGameState(matchId);
    if (state) {
      const board = JSON.parse(state.board);
      const currentTurn = state.currentTurn;
      const legalMoves = getLegalMoves(board, currentTurn);
      
      socket.emit('game_state', {
        ...state,
        legalMoves
      });
    } else {
      socket.emit('error', { message: 'Game not found' });
      return;
    }

    // 4. Notify opponent — only for live (ACTIVE) matches. A reconnection
    // notification is only ever broadcast by the actual opponent, from inside
    // the match room, so it can never describe a non-participant.
    if (match.status === 'ACTIVE') {
      socket.to(`match:${matchId}`).emit('opponent_reconnected', { userId });
    }
    logger.info({ userId, matchId }, 'Player reconnected and joined match room');
  } catch (err) {
    logger.error({ err, userId, matchId }, 'Error handling join match');
    socket.emit('error', { message: 'Failed to join match' });
  }
}
