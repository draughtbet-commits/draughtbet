import prisma from '../utils/db.js';
import logger from '../utils/logger.js';
import { lockWalletsInOrder, lockWalletForUpdate } from '../services/matchService.js';
import redis from '../utils/redis.js';
import { getIO } from './index.js';
import * as Sentry from '@sentry/node';
import { NotificationService } from '../modules/notification/service.js';

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
 * Thrown when a settlement names a winner who is not one of the two match
 * participants (S02). Raised before any database write.
 */
export class OutsiderSettlementError extends Error {
  constructor(message = 'Winner is not a participant of this match') {
    super(message);
    this.name = 'OutsiderSettlementError';
  }
}

/**
 * Thrown for any other inconsistent settlement request (mismatched loser id,
 * fee out of bounds, missing fee terms).
 */
export class InvalidSettlementError extends Error {
  constructor(message = 'Invalid settlement request') {
    super(message);
    this.name = 'InvalidSettlementError';
  }
}

/**
 * Validates the claimed winner (and optional loser) against the match
 * participants. Must run before any write touches match or ledger rows.
 */
function validateSettlementParticipants(match, winnerId, loserId) {
  const { playerLightId, playerDarkId } = match;
  if (winnerId !== playerLightId && winnerId !== playerDarkId) {
    throw new OutsiderSettlementError();
  }
  if (loserId) {
    const other = winnerId === playerLightId ? playerDarkId : playerLightId;
    if (loserId !== other) {
      throw new InvalidSettlementError('Loser is not the non-winning participant');
    }
  }
}

/**
 * Net-payout ledger convention (S16): the winner's balance moves by exactly one
 * signed PAYOUT entry (pot minus commission). The retained commission is
 * implicit platform revenue — it is NOT written as a second entry on the
 * player wallet, so balance delta always reconciles to the sum of signed
 * WalletTransaction rows for that wallet.
 */
function computeSettlement(match, commissionPercent) {
  if (!Number.isInteger(commissionPercent) || commissionPercent < 0 || commissionPercent > 100) {
    const error = new InvalidSettlementError(`Invalid commission percent: ${commissionPercent}`);
    throw error;
  }
  const pot = BigInt(match.stakeMinorUnits) * 2n;
  const commission = (pot * BigInt(commissionPercent)) / 100n;
  const payout = pot - commission;
  return { pot, commission, payout };
}

/**
 * Idempotent game settlement — DB transaction only.
 * Returns { payout, commission, match } on the first successful claim,
 * or null if the match was already settled (atomic status gate).
 *
 * S02: the match is CLAIMED atomically with an `updateMany WHERE status='ACTIVE'`;
 * competing settlements (win/win, win/draw, resign vs sweep, ...) serialize on
 * that conditional update and exactly one of them sees `count === 1`. Winner
 * membership is validated before any write, and the unique
 * (relatedMatchId, type, walletId) ledger index rejects duplicate entries.
 */
export async function settleGame(matchId, winnerId, loserId, reason) {
  const result = await prisma.$transaction(async (tx) => {
    const match = await tx.match.findUnique({
      where: { id: matchId },
      select: {
        status: true,
        stakeMinorUnits: true,
        playerLightId: true,
        playerDarkId: true,
        settlementCommissionPercent: true
      }
    });

    if (!match || match.status !== 'ACTIVE') return null;

    // Validate membership BEFORE any write.
    validateSettlementParticipants(match, winnerId, loserId);

    // Atomic claim: the single settlement gate. Exactly one concurrent caller
    // wins; every other contender returns null.
    const claimed = await tx.match.updateMany({
      where: { id: matchId, status: 'ACTIVE' },
      data: { status: 'COMPLETED', winnerId, endReason: reason, endedAt: new Date() }
    });
    if (claimed.count === 0) return null;

    // Fee terms accepted at funding time. Live settings are touched only for
    // legacy ACTIVE rows funded before the snapshot column existed.
    const settings =
      match.settlementCommissionPercent !== null && match.settlementCommissionPercent !== undefined
        ? null
        : await tx.platformSettings.findUnique({ where: { id: 'singleton' } });
    const commissionPercent = match.settlementCommissionPercent ?? settings?.commissionPercent;
    const { commission, payout } = computeSettlement(match, commissionPercent);

    // Lock the winner's wallet (serializes with withdrawals/stakes, S01),
    // then credit the net payout under the lock.
    const winnerWallet = await lockWalletForUpdate(tx, winnerId);
    await tx.wallet.update({
      where: { id: winnerWallet.id },
      data: { balanceMinorUnits: { increment: payout } }
    });

    await tx.walletTransaction.create({
      data: {
        walletId: winnerWallet.id,
        type: 'PAYOUT',
        amountMinorUnits: payout,
        relatedMatchId: matchId
      }
    });

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
    const match = await tx.match.findUnique({
      where: { id: matchId },
      select: {
        status: true,
        stakeMinorUnits: true,
        playerLightId: true,
        playerDarkId: true
      }
    });
    if (!match || match.status !== 'ACTIVE') return null;

    // Same atomic claim gate as win settlement — a draw can never race a win
    // into a double settlement.
    const claimed = await tx.match.updateMany({
      where: { id: matchId, status: 'ACTIVE' },
      data: { status: 'COMPLETED', endReason: reason, endedAt: new Date() }
    });
    if (claimed.count === 0) return null;

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
