import cron from 'node-cron';
import redis, { isRedisReady } from '../utils/redis.js';
import logger from '../utils/logger.js';
import prisma from '../utils/db.js';
import { getIO } from '../sockets/index.js';
import { debitStakes, InsufficientFundsError } from '../services/matchService.js';
import { finalizeMatchActivation } from '../services/gameActivationService.js';
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
  if (isSweeping || !isRedisReady()) return;
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
          
          // Funding and activation are SEPARATE. The atomic debit transaction is
          // the point of no return: once wallets are locked and the Match row is
          // committed (with its GameOutbox record), the pair is on the hook. We
          // must never hand them back to the queue, because re-queuing would
          // re-debit. Activation is best-effort; the recovery sweep finishes it
          // (or releases the match) if this process dies mid-way.
          let match = null;
          let funded = false;
          try {
            match = await debitStakes(player1Id, player2Id, stakeMinorUnits, tier);
            funded = true;
            const outbox = await prisma.gameOutbox.findUnique({
              where: { matchId: match.id },
              select: { id: true }
            });
            try {
              if (outbox) await finalizeMatchActivation(outbox.id);
            } catch (actErr) {
              logger.warn({ actErr, matchId: match.id }, 'Activation pending; the recovery sweep will finish it');
            }
          } catch (err) {
            if (!funded && err instanceof InsufficientFundsError) {
              const io = getIO();
              io.to(`user:${player1Id}`).emit('error', { message: 'Match failed: Insufficient funds' });
              io.to(`user:${player2Id}`).emit('error', { message: 'Match failed: Insufficient funds' });
            } else if (!funded) {
              const io = getIO();
              io.to(`user:${player1Id}`).emit('error', { message: 'Matchmaking error. Please try again.' });
              io.to(`user:${player2Id}`).emit('error', { message: 'Matchmaking error. Please try again.' });
            } else {
              throw err;
            }
            continue;
          }

          // Pair is funded; tell both players to head to the room.
          const io = getIO();
          const payload = {
            ...match,
            stakeMinorUnits: match.stakeMinorUnits.toString()
          };
          io.to(`user:${player1Id}`).emit('match_found', payload);
          io.to(`user:${player2Id}`).emit('match_found', payload);
          
          const notifyMatch = async (uid) => {
            await NotificationService.create(
              uid,
              'MATCH_FOUND',
              'Match Found!',
              'An opponent has been found. Your match is starting.',
              `/match/${match.id}`
            );
          };
          try {
            await Promise.all([notifyMatch(player1Id), notifyMatch(player2Id)]);
          } catch (notifyErr) {
            logger.warn({ notifyErr, matchId: match.id }, 'Match found notifications failed');
          }
          
          logger.info({ p1: player1Id, p2: player2Id, matchId: match.id, tier, stakeMinorUnits: stakeMinorUnits.toString() }, 'Matchmaking pair found and game started');
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
