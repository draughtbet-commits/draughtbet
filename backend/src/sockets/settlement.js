import prisma from '../utils/db.js';
import logger from '../utils/logger.js';
import { lockWalletsInOrder } from '../services/matchService.js';
import redis from '../utils/redis.js';
import { getIO } from './index.js';
import * as Sentry from '@sentry/node';

// Utility sleep function
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  try { await redis.del(`user:${playerLightId}:activeMatch`); } catch (e) { logger.warn({ e, matchId }, 'Redis del activeMatch failed'); }
  try { await redis.del(`user:${playerDarkId}:activeMatch`); } catch (e) { logger.warn({ e, matchId }, 'Redis del activeMatch failed'); }

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
  } catch (e) {
    logger.warn({ e, matchId }, 'Socket emit after settlement failed');
  }
}

/**
 * Cleans up Redis keys and emits socket events after a draw settlement.
 */
async function notifyAndCleanupDraw(matchId, playerLightId, playerDarkId, refundAmount, reason) {
  try { await redis.del(`match:${matchId}`); } catch (e) { logger.warn({ e, matchId }, 'Redis del match key failed'); }
  try { await redis.del(`user:${playerLightId}:activeMatch`); } catch (e) { logger.warn({ e, matchId }, 'Redis del activeMatch failed'); }
  try { await redis.del(`user:${playerDarkId}:activeMatch`); } catch (e) { logger.warn({ e, matchId }, 'Redis del activeMatch failed'); }

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
 * Reads match details from Postgres, computes payout (from actual WalletTransactions),
 * and runs notification/cleanup. Called when we know the DB already shows
 * COMPLETED but aren't sure cleanup ran.
 */
async function runCleanupFromDbForWin(matchId) {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: { 
      status: true, 
      stakeMinorUnits: true, 
      playerLightId: true, 
      playerDarkId: true,
      winnerId: true,
      endReason: true 
    }
  });
  
  if (!match || match.status !== 'COMPLETED') return;

  // Read the actual payout that was committed, rather than recomputing it
  // against potentially changed commission settings.
  const payoutTx = await prisma.walletTransaction.findFirst({
    where: { relatedMatchId: matchId, type: 'PAYOUT' }
  });

  const payout = payoutTx ? payoutTx.amountMinorUnits : 0n;

  await notifyAndCleanupWin(
    matchId, 
    match.winnerId, 
    match.playerLightId, 
    match.playerDarkId, 
    payout, 
    match.endReason
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
  if (!match || match.status !== 'COMPLETED') return;

  await notifyAndCleanupDraw(matchId, match.playerLightId, match.playerDarkId, match.stakeMinorUnits, match.endReason);
}

// ─────────────────────────────────────────────────────────────
// DB settlement (idempotent — returns result on first call, null on subsequent)
// ─────────────────────────────────────────────────────────────

/**
 * Idempotent game settlement — DB transaction only.
 * Returns { payout, commission, match } on first successful call,
 * or null if already settled (idempotency gate).
 */
export async function settleGame(matchId, winnerId, loserId, reason) {
  const result = await prisma.$transaction(async (tx) => {
    const match = await tx.match.findUnique({
      where: { id: matchId },
      select: { status: true, stakeMinorUnits: true, playerLightId: true, playerDarkId: true }
    });

    if (!match || match.status !== 'ACTIVE') return null;

    await tx.match.update({ where: { id: matchId }, data: {
      status: 'COMPLETED', winnerId, endReason: reason, endedAt: new Date()
    }});

    const settings = await tx.platformSettings.findUniqueOrThrow({ where: { id: 'singleton' } });

    const pot = BigInt(match.stakeMinorUnits) * 2n;
    const commission = (pot * BigInt(settings.commissionPercent)) / 100n;
    const payout = pot - commission;

    const winnerWallet = await tx.wallet.findUniqueOrThrow({ where: { userId: winnerId } });
    await tx.wallet.update({ where: { id: winnerWallet.id }, data: {
      balanceMinorUnits: { increment: payout }
    }});

    await tx.walletTransaction.create({ data: {
      walletId: winnerWallet.id, type: 'PAYOUT',
      amountMinorUnits: payout, relatedMatchId: matchId
    }});
    await tx.walletTransaction.create({ data: {
      walletId: winnerWallet.id, type: 'COMMISSION',
      amountMinorUnits: -commission, relatedMatchId: matchId
    }});

    return { payout, commission, match };
  });

  if (result) {
    await notifyAndCleanupWin(
      matchId, winnerId,
      result.match.playerLightId, result.match.playerDarkId,
      result.payout, reason
    );
  }

  return result;
}

export async function settleGameDraw(matchId, reason) {
  const result = await prisma.$transaction(async (tx) => {
    const match = await tx.match.findUnique({ where: { id: matchId } });
    if (!match || match.status !== 'ACTIVE') return null;

    await tx.match.update({ where: { id: matchId }, data: {
      status: 'COMPLETED', endReason: reason, endedAt: new Date()
    }});

    const [w1, w2] = await lockWalletsInOrder(tx, match.playerLightId, match.playerDarkId);

    for (const w of [w1, w2]) {
      await tx.wallet.update({ where: { id: w.id }, data: {
        balanceMinorUnits: { increment: match.stakeMinorUnits }
      }});
      await tx.walletTransaction.create({ data: {
        walletId: w.id, type: 'REFUND',
        amountMinorUnits: match.stakeMinorUnits, relatedMatchId: matchId
      }});
    }

    return { match };
  });

  if (result) {
    await notifyAndCleanupDraw(
      matchId,
      result.match.playerLightId, result.match.playerDarkId,
      result.match.stakeMinorUnits, reason
    );
  }

  return result;
}

// ─────────────────────────────────────────────────────────────
// Retry wrappers
//
// The key invariant: on EVERY non-throwing return from settleGame/Draw,
// we check the return value. If it's null, the DB already committed
// (from a previous attempt whose cleanup threw). In that case we
// attempt cleanup directly — we don't treat "null without throwing"
// as success and return silently.
//
// This closes the gap where:
//   1. Attempt 1: DB commits, cleanup throws → settleGame throws
//   2. Attempt 2: idempotency gate returns null, no throw
//   3. Old code: treated non-throw as success → returned → cleanup never ran
//   4. New code: detects null → runs cleanup from DB state
// ─────────────────────────────────────────────────────────────

export async function settleGameWithRetry(matchId, winnerId, loserId, reason, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await settleGame(matchId, winnerId, loserId, reason);

      if (result) {
        // DB settled AND cleanup ran (settleGame didn't throw) — genuine success.
        return;
      }

      // result === null: DB is already COMPLETED (idempotency gate).
      // A previous attempt committed the txn but cleanup may have thrown.
      // Attempt cleanup now — it's idempotent, so running it again is safe.
      logger.info({ matchId, attempt }, 'settleGameWithRetry: DB already settled (idempotency gate), running cleanup');
      try {
        await runCleanupFromDbForWin(matchId);
      } catch (cleanupErr) {
        logger.error({ cleanupErr, matchId }, 'settleGameWithRetry: cleanup after idempotency gate failed');
      }
      return;

    } catch (err) {
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
}

export async function settleGameDrawWithRetry(matchId, reason, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await settleGameDraw(matchId, reason);

      if (result) {
        return; // Genuine success
      }

      // Idempotency gate fired — attempt cleanup directly
      logger.info({ matchId, attempt }, 'settleGameDrawWithRetry: DB already settled (idempotency gate), running cleanup');
      try {
        await runCleanupFromDbForDraw(matchId);
      } catch (cleanupErr) {
        logger.error({ cleanupErr, matchId }, 'settleGameDrawWithRetry: cleanup after idempotency gate failed');
      }
      return;

    } catch (err) {
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
}
