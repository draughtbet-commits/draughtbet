import { v4 as uuidv4 } from 'uuid';
import redis from '../utils/redis.js';
import logger from '../utils/logger.js';
import { getIO } from './index.js';
import { initializeGame } from './gameManager.js';

/**
 * Handles a user joining the matchmaking queue for a specific stake tier.
 * If an opponent is found, it automatically starts a game.
 */
export const joinQueue = async (socket, userId, stakeTier) => {
  const queueKey = `queue:${stakeTier}`;
  
  try {
    // 1. Check if an opponent is already waiting in the queue
    // We fetch the oldest waiting user (lowest score/timestamp)
    const opponents = await redis.zrange(queueKey, 0, 0);
    
    if (opponents.length > 0) {
      const opponentId = opponents[0];
      
      // Don't match the user against themselves
      if (opponentId === userId) {
        return;
      }
      
      // 2. Try to atomically pop the opponent from the queue
      const removed = await redis.zrem(queueKey, opponentId);
      
      if (removed === 1) {
        // We successfully matched!
        logger.info({ p1: opponentId, p2: userId, tier: stakeTier }, 'Match found');
        
        const gameId = uuidv4();
        
        // Initialize the game state in Redis
        const gameState = await initializeGame(gameId, opponentId, userId, stakeTier);
        
        const io = getIO();
        
        // Find the sockets for both users and make them join the game room
        // In Socket.IO, we can find sockets by iterating or keeping a map.
        // A common pattern is having sockets join a room matching their userId upon connection.
        const roomName = `match:${gameId}`;
        
        const sockets = await io.fetchSockets();
        sockets.forEach((s) => {
          if (s.user?.userId === userId || s.user?.userId === opponentId) {
            s.join(roomName);
          }
        });
        
        // Emit game_start to the room
        io.to(roomName).emit('game_start', {
          gameId,
          state: gameState
        });
        
        return;
      }
    }
    
    // 3. No opponent found, or race condition on pop. Add user to queue.
    await redis.zadd(queueKey, Date.now(), userId);
    logger.info({ userId, tier: stakeTier }, 'User joined matchmaking queue');
    
  } catch (err) {
    logger.error({ err, userId, stakeTier }, 'Error in matchmaking joinQueue');
    socket.emit('error', { message: 'Matchmaking failed' });
  }
};

/**
 * Removes a user from the queue (e.g. they cancelled or disconnected)
 */
export const leaveQueue = async (userId, stakeTier) => {
  const queueKey = `queue:${stakeTier}`;
  try {
    await redis.zrem(queueKey, userId);
    logger.info({ userId, tier: stakeTier }, 'User left matchmaking queue');
  } catch (err) {
    logger.error({ err, userId, stakeTier }, 'Error in matchmaking leaveQueue');
  }
};
