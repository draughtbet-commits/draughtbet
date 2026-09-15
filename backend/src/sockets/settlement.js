import logger from '../utils/logger.js';
import prisma from '../utils/db.js';
import redis from '../utils/redis.js';
import { getIO } from './index.js';
import * as Sentry from '@sentry/node';
import { NotificationService } from '../modules/notification/service.js';
import {
  SettlementService,
  DEFAULT_SETTLEMENT_RETRIES,
  OutsiderSettlementError,
  InvalidSettlementError
} from '../modules/settlement/service.js';

export { OutsiderSettlementError, InvalidSettlementError } from '../modules/settlement/service.js';

// Utility sleep function
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// CAS-delete: only remove the user's activeMatch pointer when it still points
// at this match, so cleanup can never wipe a pointer that belongs to a newer
// match the user just started. Compare-and-delete is safe in single-instance
// Socket.IO (no shared adapter; see "represent presence" item).
const deleteActiveMatchIfOwnedLua = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

const deleteActiveMatchPointer = async (userId, matchId) => {
  try {
    await redis.eval(deleteActiveMatchIfOwnedLua, 1, `user:${userId}:activeMatch`, matchId);
  } catch (e) {
    logger.warn({ e, userId, matchId }, 'Redis delete activeMatch pointer failed');
  }
};

// ─────────────────────────────────────────────────────────────
// Post-settlement cleanup & notification (independent of DB)
//
// These are idempotent by nature:
//   - redis.del on a missing key = 0 (no-op)
//   - duplicate socket emits are harmless (client handles gracefully)
// So calling them more than once is always safe.
// ─────────────────────────────────────────────────────────────

/**
 * Cleans up Redis keys and emits socket events after a win settlement.
 */
async function notifyAndCleanupWin(matchId, winnerId, playerLightId, playerDarkId, payout, reason) {
  // Each operation is fault-isolated — one failure doesn't prevent the rest
  try { await redis.del(`match:${matchId}`); } catch (e) { logger.warn({ e, matchId }, 'Redis del match key failed'); }
  await deleteActiveMatchPointer(playerLightId, matchId);
  await deleteActiveMatchPointer(playerDarkId, matchId);

  try {
    const io = getIO();
    io.to(`match:${matchId}`).emit('match_ended', {
      winnerId,
      reason,
      payout: payout.toString()
    });
    io.to(`user:${winnerId}`).emit('wallet_updated', {
      balanceChange: payout.toString(),
      matchId
    });

    const loserId = winnerId === playerLightId ? playerDarkId : playerLightId;

    // Trigger WIN/LOSS notifications
    await NotificationService.create(
      winnerId,
      'MATCH_ENDED_WIN',
      'You Won!',
      `You won match ${matchId.slice(0, 8)}. Payout: ${payout} credited.`,
      `/results`
    );

    await NotificationService.create(
      loserId,
      'MATCH_ENDED_LOSS',
      'You Lost',
      `You lost match ${matchId.slice(0, 8)}. Better luck next time!`,
      `/results`
    );
  } catch (e) {
    logger.warn({ e, matchId }, 'Socket emit after settlement failed');
  }
}

/**
 * Cleans up Redis keys and emits socket events after a draw settlement.
 */
async function notifyAndCleanupDraw(matchId, playerLightId, playerDarkId, refundAmount, reason) {
  try { await redis.del(`match:${matchId}`); } catch (e) { logger.warn({ e, matchId }, 'Redis del match key failed'); }
  await deleteActiveMatchPointer(playerLightId, matchId);
  await deleteActiveMatchPointer(playerDarkId, matchId);

  try {
    const io = getIO();
    io.to(`match:${matchId}`).emit('match_ended', {
      winnerId: null,
      reason,
      payout: refundAmount.toString()
    });
    io.to(`user:${playerLightId}`).emit('wallet_updated', {
      balanceChange: refundAmount.toString(),
      matchId
    });
    io.to(`user:${playerDarkId}`).emit('wallet_updated', {
      balanceChange: refundAmount.toString(),
      matchId
    });
  } catch (e) {
    logger.warn({ e, matchId }, 'Socket emit after draw settlement failed');
  }
}

// ─────────────────────────────────────────────────────────────
// Standalone cleanup from DB state (used when the idempotency
// gate has fired, meaning the DB txn committed previously but
// cleanup may not have run).
// ─────────────────────────────────────────────────────────────

/**
 * Reads the terminal settlement record from Postgres and runs
 * notification/cleanup. Called when we know the DB already settled but aren't
 * sure cleanup ran. Falls back to the legacy PAYOUT mirror row for matches
 * settled before the MatchSettlement record existed.
 */
async function readSettlementOrLegacyPayout(matchId) {
  const settlement = await prisma.matchSettlement.findUnique({ where: { matchId } });
  if (settlement) return settlement;

  const payoutTx = await prisma.walletTransaction.findFirst({
    where: { relatedMatchId: matchId, type: 'PAYOUT' }
  });
  return payoutTx ? { winnerId: null, netPayoutMinorUnits: payoutTx.amountMinorUnits, endReason: null } : null;
}

async function runCleanupFromDbForWin(matchId) {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      status: true,
      playerLightId: true,
      playerDarkId: true,
      winnerId: true,
      endReason: true
    }
  });

  if (!match || match.status !== 'SETTLED') return;

  const record = await readSettlementOrLegacyPayout(matchId);
  if (!record) return;
  const winnerId = record.winnerId ?? match.winnerId;
  if (!winnerId) return;

  await notifyAndCleanupWin(
    matchId,
    winnerId,
    match.playerLightId,
    match.playerDarkId,
    BigInt(record.netPayoutMinorUnits),
    record.endReason ?? match.endReason
  );
}

async function runCleanupFromDbForDraw(matchId) {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      status: true,
      stakeMinorUnits: true,
      playerLightId: true,
      playerDarkId: true,
      endReason: true
    }
  });
  if (!match || match.status !== 'SETTLED') return;

  await notifyAndCleanupDraw(matchId, match.playerLightId, match.playerDarkId, match.stakeMinorUnits, match.endReason);
}

// ─────────────────────────────────────────────────────────────
// Socket-layer settlement (financial core lives in SettlementService)
// ─────────────────────────────────────────────────────────────

/**
 * Idempotent win settlement. Financial movement (ledger + legacy mirror +
 * MatchSettlement + MatchReceipt) is delegated to SettlementService; the
 * socket layer keeps the post-settlement notification/cleanup concept.
 *
 * Returns { payout, commission, match } on the first successful claim (the
 * established Flutter-facing result payload), or the same shape for a replay.
 */
export async function settleGame(matchId, winnerId, loserId, reason) {
  // Validated-rejectable requests (outsider winner, missing evidence) throw
  // Outsider/InvalidSettlementError straight through; the retry wrapper treats
  // only transient failures as retryable.
  const result = await SettlementService.settleMatch(matchId, {
    result: 'WIN',
    winnerId,
    loserId,
    endReason: reason
  });

  if (result.claimed) {
    await notifyAndCleanupWin(
      matchId, winnerId,
      result.match.playerLightId, result.match.playerDarkId,
      result.payout, reason
    );
  } else {
    // Idempotency gate fired: DB already settled, cleanup may not have run.
    await runCleanupFromDbForWin(matchId);
  }

  return { payout: result.payout, commission: result.commission, match: result.match };
}

export async function settleGameDraw(matchId, reason) {
  const result = await SettlementService.settleMatch(matchId, {
    result: 'DRAW',
    endReason: reason
  });

  if (result.claimed) {
    await notifyAndCleanupDraw(
      matchId,
      result.match.playerLightId, result.match.playerDarkId,
      result.match.stakeMinorUnits, reason
    );
  } else {
    await runCleanupFromDbForDraw(matchId);
  }

  return { payout: result.payout, commission: result.commission, match: result.match };
}

// ─────────────────────────────────────────────────────────────
// Retry wrappers
//
// The key invariant: on EVERY non-throwing return from settleGame/Draw,
// we check the return value. If `claimed` is false, the DB already committed
// (from a previous attempt whose cleanup threw). In that case we
// attempt cleanup directly — we don't treat "false without throwing"
// as success and return silently.
//
// This closes the gap where:
//   1. Attempt 1: DB commits, cleanup throws → settleGame throws
//   2. Attempt 2: idempotency gate returns replayed, no throw
//   3. Old code: treated non-throw as success → returned → cleanup never ran
//   4. New code: detects replayed → runs cleanup from DB state
//
// Settlement is retried 10 times; the claim + posting are transactional and
// idempotent, so the winner is credited exactly once no matter the attempts.
// ─────────────────────────────────────────────────────────────

export async function settleGameWithRetry(matchId, winnerId, loserId, reason, retries = DEFAULT_SETTLEMENT_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await settleGame(matchId, winnerId, loserId, reason);

      if (result) {
        // DB settled AND cleanup ran (settleGame didn't throw) — genuine success.
        return result;
      }

      logger.info({ matchId, attempt }, 'settleGameWithRetry: settlement returned no result, running cleanup');
      try {
        await runCleanupFromDbForWin(matchId);
      } catch (cleanupErr) {
        logger.error({ cleanupErr, matchId }, 'settleGameWithRetry: cleanup after settlement gate failed');
      }
      return null;

    } catch (err) {
      // Rejectable requests (outsider winner, missing evidence) are not
      // transient — surface them instead of burning the retry budget.
      if (err instanceof OutsiderSettlementError || err instanceof InvalidSettlementError) {
        throw err;
      }
      logger.warn({ err, attempt, matchId }, 'settleGame failed, retrying');
      if (attempt === retries) {
        logger.error({ err, matchId }, 'CRITICAL: settleGame failed after all retries. Requires manual or sweep reconciliation.');
        if (Sentry && typeof Sentry.captureException === 'function') {
          Sentry.captureException(err, {
            level: 'fatal',
            tags: { subsystem: 'settlement' },
            extra: { matchId, winnerId, reason }
          });
        }
      } else {
        await sleep(attempt * 500);
      }
    }
  }

  // All retries threw. One final check: did the DB actually commit on
  // some attempt where the error came from cleanup, not the txn?
  try {
    await runCleanupFromDbForWin(matchId);
  } catch (cleanupErr) {
    logger.error({ cleanupErr, matchId }, 'settleGameWithRetry: final cleanup attempt also failed');
  }
  return null;
}

export async function settleGameDrawWithRetry(matchId, reason, retries = DEFAULT_SETTLEMENT_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await settleGameDraw(matchId, reason);

      if (result) {
        return result; // Genuine success
      }

      // Settlement gate fired — attempt cleanup directly
      logger.info({ matchId, attempt }, 'settleGameDrawWithRetry: settlement returned no result, running cleanup');
      try {
        await runCleanupFromDbForDraw(matchId);
      } catch (cleanupErr) {
        logger.error({ cleanupErr, matchId }, 'settleGameDrawWithRetry: cleanup after settlement gate failed');
      }
      return null;

    } catch (err) {
      if (err instanceof OutsiderSettlementError || err instanceof InvalidSettlementError) {
        throw err;
      }
      logger.warn({ err, attempt, matchId }, 'settleGameDraw failed, retrying');
      if (attempt === retries) {
        logger.error({ err, matchId }, 'CRITICAL: settleGameDraw failed after all retries.');
        if (Sentry && typeof Sentry.captureException === 'function') {
          Sentry.captureException(err, {
            level: 'fatal',
            tags: { subsystem: 'settlement' },
            extra: { matchId, reason }
          });
        }
      } else {
        await sleep(attempt * 500);
      }
    }
  }

  // All retries threw — final cleanup attempt
  try {
    await runCleanupFromDbForDraw(matchId);
  } catch (cleanupErr) {
    logger.error({ cleanupErr, matchId }, 'settleGameDrawWithRetry: final cleanup attempt also failed');
  }
  return null;
}

export { SettlementService, DEFAULT_SETTLEMENT_RETRIES };