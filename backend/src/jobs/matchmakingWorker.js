import cron from 'node-cron';
import redis, { isRedisReady } from '../utils/redis.js';
import logger from '../utils/logger.js';
import prisma from '../utils/db.js';
import { getIO } from '../sockets/index.js';
import { debitStakes, InsufficientFundsError, ActiveMatchError } from '../services/matchService.js';
import { finalizeMatchActivation } from '../services/gameActivationService.js';
import { NotificationService } from '../modules/notification/service.js';
import { fundOpenMatch, OPEN_MATCH_TTL_MS } from '../modules/v2/lifecycleService.js';

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

// Lua script to atomically pop a single (oldest) player from the queue.
// Used to seat one waiting player into an already-open match.
// KEYS[1] = queueKey
const popOneLua = `
  local queueKey = KEYS[1]
  local players = redis.call('ZRANGE', queueKey, 0, 0)
  if #players == 1 then
    redis.call('ZREM', queueKey, players[1])
    return players[1]
  end
  return nil
`;

// Define script on redis instance if available (it might be null in tests)
if (redis) {
  redis.defineCommand('popMatchmakingPair', {
    numberOfKeys: 1,
    lua: popPairLua
  });
  redis.defineCommand('popMatchmakingPlayer', {
    numberOfKeys: 1,
    lua: popOneLua
  });
}

let isSweeping = false;

/**
 * Finds the oldest open match in this bucket that a waiting player could join.
 *
 * Excludes matches already earmarked for someone else (a pending directed
 * challenge), private-room listings (code-only, never auto-seated) and matches
 * the queued player's own, and skips anything past the open-match TTL so the
 * caller does not spin on a match it can never fund.
 */
const findJoinableOpenMatch = async (tier, stakeMinorUnits) => {
  const candidates = await prisma.match.findMany({
    where: {
      status: 'OPEN',
      tier,
      stakeMinorUnits: BigInt(stakeMinorUnits),
      visibility: { not: 'PRIVATE' },
      createdAt: { gte: new Date(Date.now() - OPEN_MATCH_TTL_MS) }
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      playerLightId: true,
      stakeMinorUnits: true,
      playerDarkId: true
    }
  });

  for (const candidate of candidates) {
    // A directed challenge is not a public seat.
    const challenge = await prisma.matchChallenge.findFirst({
      where: { matchId: candidate.id, status: 'PENDING' },
      select: { id: true, inviteeId: true }
    });
    if (challenge) continue;
    if (!candidate.playerDarkId) return candidate;
  }
  return null;
};

/**
 * Moves waiting players into compatible open matches.
 *
 * Bounded per sweep so a match that cannot be funded (insufficient funds,
 * ineligibility) cannot spin this worker.
 */
const seatQueuedPlayersIntoOpenMatches = async (queueKey, tier, stakeMinorUnits) => {
  if (!isRedisReady()) return;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const openMatch = await findJoinableOpenMatch(tier, stakeMinorUnits);
    if (!openMatch) return;

    const queuedPlayerId = await redis.popMatchmakingPlayer(queueKey);
    if (!queuedPlayerId) return;

    // The owner is already the opponent; put them back and stop, otherwise we
    // would keep popping and re-queueing the same player.
    if (queuedPlayerId === openMatch.playerLightId) {
      await redis.zadd(queueKey, Date.now(), queuedPlayerId);
      return;
    }

    try {
      const match = await fundOpenMatch(queuedPlayerId, openMatch.id, { tier });

      const outbox = await prisma.gameOutbox.findUnique({
        where: { matchId: match.id },
        select: { id: true }
      });
      if (outbox) {
        try {
          await finalizeMatchActivation(outbox.id);
        } catch (actErr) {
          logger.warn(
            { actErr, matchId: match.id },
            'Open-match activation pending; the recovery sweep will finish it'
          );
        }
      }

      const payload = { ...match, stakeMinorUnits: match.stakeMinorUnits.toString() };
      const io = getIO();
      io.to(`user:${match.playerLightId}`).emit('match_found', payload);
      io.to(`user:${match.playerDarkId}`).emit('match_found', payload);

      logger.info(
        { matchId: match.id, tier, stakeMinorUnits },
        'Seated queued player into open match'
      );
    } catch (err) {
      // The waiting player is not eligible for this match (or the funds are not
      // there). Tell them rather than leaving them in a silent search, and stop
      // looking at this match so the next sweep can reconsider it fresh.
      logger.warn(
        { err, openMatchId: openMatch.id, queuedPlayerId },
        'Could not seat queued player into open match'
      );
      const io = getIO();
      io.to(`user:${queuedPlayerId}`).emit('error', {
        message: err?.message || 'Could not join that open match'
      });
      return;
    }
  }
};

const QUEUE_KEY_PATTERN = 'queue:*';

/**
 * Parses a `queue:<tier>:<stakeMinorUnits>` key into its parts.
 *
 * Stakes are a free-form range now, so the set of live buckets is unbounded and
 * cannot be enumerated from a constant. Anything that does not look like a real
 * bucket (wrong shape, non-numeric stake) is ignored rather than guessed at.
 */
const parseQueueKey = (key) => {
  const parts = key.split(':');
  if (parts.length !== 3) return null;

  const [, tier, stakeRaw] = parts;
  if (!tier || !stakeRaw) return null;

  let stakeMinorUnits;
  try {
    stakeMinorUnits = BigInt(stakeRaw);
  } catch {
    return null;
  }
  if (stakeMinorUnits <= 0n) return null;

  return { tier, stakeMinorUnits };
};

/**
 * Returns every live matchmaking queue bucket key.
 *
 * Empty Redis sorted sets are deleted automatically once their last member is
 * popped/zrem'd, so a SCAN only ever surfaces buckets that currently have at
 * least one waiting player. We page through with SCAN (never KEYS) so this stays
 * cheap regardless of how many keys share the keyspace.
 */
const discoverQueueKeys = async () => {
  const keys = [];
  let cursor = '0';
  do {
    const [nextCursor, batch] = await redis.scan(
      cursor,
      'MATCH',
      QUEUE_KEY_PATTERN,
      'COUNT',
      100
    );
    cursor = nextCursor;
    if (batch && batch.length) keys.push(...batch);
  } while (cursor !== '0');
  return keys;
};

export const processMatchmakingQueues = async () => {
  if (isSweeping || !isRedisReady()) return;
  isSweeping = true;

  try {
    const queueKeys = await discoverQueueKeys();
    for (const queueKey of queueKeys) {
      const parsed = parseQueueKey(queueKey);
      if (!parsed) continue;
      const { tier, stakeMinorUnits } = parsed;

        // Seat waiting players into matches that are already open before trying
        // to pair queue entries with each other.
        //
        // Pairing only ever considered two players in the same queue bucket, so
        // an open match was invisible to it: its owner is not queued (they are
        // barred from queueing at all while holding one), and a queued player
        // was never offered it. With only two players that made matching
        // impossible - one waits in the queue while the other waits in an open
        // match, forever.
        await seatQueuedPlayersIntoOpenMatches(queueKey, tier, stakeMinorUnits);

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
            if (!funded && err instanceof ActiveMatchError) {
              // The pair reached the funding check but one player already holds
              // an ACTIVE match (double-enqueue, or they just started a game).
              // They were removed from the queue and are not re-queued.
              const io = getIO();
              io.to(`user:${player1Id}`).emit('error', { message: 'Match failed: you are already in a match' });
              io.to(`user:${player2Id}`).emit('error', { message: 'Match failed: you are already in a match' });
            } else if (!funded && err instanceof InsufficientFundsError) {
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
              `/match/${match.id}`,
              match.id
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
