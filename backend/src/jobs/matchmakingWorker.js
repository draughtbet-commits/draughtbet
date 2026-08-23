import cron from 'node-cron';
import redis from '../utils/redis.js';
import logger from '../utils/logger.js';
import { getIO } from '../sockets/index.js';
import { debitStakes, InsufficientFundsError } from '../services/matchService.js';
import { initializeGame } from '../sockets/gameManager.js';
import { STAKE_PRESETS } from '../middleware/tierEnforcement.js';
import { NotificationService } from '../modules/notification/service.js';

// Lua script to atomically pop two players from the queue
// KEYS[1] = queueKey
const popPairLua = `
  local queueKey = KEYS[1]
  local players = redis.call('ZRANGE', queueKey, 0, 1)
  if #players == 2 then
    redis.call('ZREM', queueKey, players[1], players[2])
    return players
  end
  return nil
`;

// Define script on redis instance if available (it might be null in tests)
if (redis) {
  redis.defineCommand('popMatchmakingPair', {
    numberOfKeys: 1,
    lua: popPairLua
  });
}

let isSweeping = false;

export const processMatchmakingQueues = async () => {
  if (isSweeping) return;
  isSweeping = true;

  try {
    for (const [tier, presets] of Object.entries(STAKE_PRESETS)) {
      for (const stakeMinorUnits of presets) {
        const queueKey = `queue:${tier}:${stakeMinorUnits.toString()}`;
        
        // Continuously pop pairs from this bucket until empty or < 2
        while (true) {
          const pair = await redis.popMatchmakingPair(queueKey);
          
          if (!pair) {
            break; // No more complete pairs in this bucket
          }
          
          const [player1Id, player2Id] = pair;
          
          try {
            // 1. Atomically debit stakes and create DB match
            const match = await debitStakes(player1Id, player2Id, stakeMinorUnits, tier);
            
            // 2. Initialize Redis state
            await initializeGame(match.id, player1Id, player2Id, tier);
            
            // 3. Notify players
            const io = getIO();
            const payload = {
              ...match,
              stakeMinorUnits: match.stakeMinorUnits.toString()
            };
            io.to(`user:${player1Id}`).emit('match_found', payload);
            io.to(`user:${player2Id}`).emit('match_found', payload);
            
            // Trigger MATCH_FOUND notifications for both players
            const notifyMatch = async (uid) => {
              await NotificationService.create(
                uid,
                'MATCH_FOUND',
                'Match Found!',
                'An opponent has been found. Your match is starting.',
                `/match/${match.id}`
              );
            };
            await Promise.all([notifyMatch(player1Id), notifyMatch(player2Id)]);
            
            logger.info({ p1: player1Id, p2: player2Id, matchId: match.id, tier, stakeMinorUnits: stakeMinorUnits.toString() }, 'Matchmaking pair found and game started');
            
          } catch (err) {
            // If creation fails (e.g., insufficient funds during DB lock), 
            // we must evict the failing player(s) and potentially requeue the other.
            logger.warn({ err, player1Id, player2Id }, 'Failed to create match for popped pair');
            
            // It's non-trivial to know WHICH player had insufficient funds purely from the generic error
            // (though our lock logic throws generically). 
            // The safest thing is to notify both players of the error and leave them dequeued.
            // They will have to re-queue.
            const io = getIO();
            if (err instanceof InsufficientFundsError) {
              io.to(`user:${player1Id}`).emit('error', { message: 'Match failed: Insufficient funds' });
              io.to(`user:${player2Id}`).emit('error', { message: 'Match failed: Insufficient funds' });
            } else {
              io.to(`user:${player1Id}`).emit('error', { message: 'Matchmaking error. Please try again.' });
              io.to(`user:${player2Id}`).emit('error', { message: 'Matchmaking error. Please try again.' });
            }
          }
        }
      }
    }
  } catch (err) {
    logger.error({ err }, 'Error during matchmaking sweep');
  } finally {
    isSweeping = false;
  }
};

export const startMatchmakingWorker = () => {
  // Run every 3 seconds
  cron.schedule('*/3 * * * * *', () => {
    processMatchmakingQueues();
  });
  logger.info('Matchmaking worker started');
};
