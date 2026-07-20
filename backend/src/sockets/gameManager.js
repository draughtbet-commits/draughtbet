import redis from '../../utils/redis.js';
import logger from '../../utils/logger.js';
import { initialBoard } from '../engine/board.js';

const GAME_STATE_TTL = 24 * 60 * 60; // 24 hours just in case a game is abandoned

/**
 * Initializes a new game in Redis
 */
export const initializeGame = async (gameId, player1Id, player2Id, stakeTier) => {
  const gameStateKey = `game:${gameId}`;
  
  const initialState = {
    gameId,
    stakeTier,
    player1: player1Id, // White pieces
    player2: player2Id, // Black pieces
    currentTurn: 'white',
    board: JSON.stringify(initialBoard()),
    status: 'in_progress', // 'in_progress', 'completed', 'draw'
    lastMoveTimestamp: Date.now()
  };
  
  try {
    await redis.hset(gameStateKey, initialState);
    await redis.expire(gameStateKey, GAME_STATE_TTL);
    
    // Parse the board back to an array for the client event
    return {
      ...initialState,
      board: initialBoard()
    };
  } catch (err) {
    logger.error({ err, gameId }, 'Failed to initialize game state in Redis');
    throw err;
  }
};
