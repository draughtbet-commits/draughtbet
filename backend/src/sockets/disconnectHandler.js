import redis from '../utils/redis.js';
import { getIO } from './index.js';
import { getActiveGameForUser, getGameState } from './gameManager.js';
import logger from '../utils/logger.js';

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
    logger.info({ userId, matchId }, 'Player disconnected, started 60s grace period');
  } catch (err) {
    logger.error({ err, userId }, 'Error handling disconnect');
  }
}

export async function handleJoinMatch(socket, { matchId }) {
  const userId = socket.user?.userId;
  if (!userId) return;

  try {
    // 1. Remove from sorted set
    await redis.zrem('disconnects', `${matchId}:${userId}`);

    // 2. Rejoin Socket.IO room
    socket.join(`match:${matchId}`);

    // 3. Send current game state
    const state = await getGameState(matchId);
    if (state) {
      socket.emit('game_state', state);
    } else {
      socket.emit('error', { message: 'Game not found' });
      return;
    }

    // 4. Notify opponent
    socket.to(`match:${matchId}`).emit('opponent_reconnected', { userId });
    logger.info({ userId, matchId }, 'Player reconnected and joined match room');
  } catch (err) {
    logger.error({ err, userId, matchId }, 'Error handling join match');
    socket.emit('error', { message: 'Failed to join match' });
  }
}
