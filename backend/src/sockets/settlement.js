import prisma from '../utils/db.js';
import logger from '../utils/logger.js';
import { lockWalletsInOrder } from '../services/matchService.js';
import redis from '../utils/redis.js';
import { getIO } from './index.js';
import * as Sentry from '@sentry/node';

// Utility sleep function
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Idempotent game settlement.
 */
export async function settleGame(matchId, winnerId, loserId, reason) {
  const result = await prisma.$transaction(async (tx) => {
    // === IDEMPOTENCY GATE (inside the transaction, under implicit row lock) ===
    const match = await tx.match.findUnique({
      where: { id: matchId },
      select: { status: true, stakeMinorUnits: true, playerLightId: true, playerDarkId: true }
    });

    // If already settled, bail out — this is the idempotency guard
    if (!match || match.status !== 'ACTIVE') return null;

    // === PROCEED (first caller only reaches here) ===

    // 1. Update Match: status = COMPLETED
    await tx.match.update({ where: { id: matchId }, data: {
      status: 'COMPLETED', winnerId, endReason: reason, endedAt: new Date()
    }});

    // 2. Look up commission
    const settings = await tx.platformSettings.findUniqueOrThrow({ where: { id: 'singleton' } });

    // 3. Calculate payout
    const pot = BigInt(match.stakeMinorUnits) * 2n;
    const commission = (pot * BigInt(settings.commissionPercent)) / 100n;
    const payout = pot - commission;

    // 4. Credit winner's wallet
    const winnerWallet = await tx.wallet.findUniqueOrThrow({ where: { userId: winnerId } });
    await tx.wallet.update({ where: { id: winnerWallet.id }, data: {
      balanceMinorUnits: { increment: payout }
    }});

    // 5. Write WalletTransactions (PAYOUT + COMMISSION)
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
    // Cleanup Redis
    await redis.del(`match:${matchId}`);
    await redis.del(`user:${result.match.playerLightId}:activeMatch`);
    await redis.del(`user:${result.match.playerDarkId}:activeMatch`);
    
    // Notify clients
    const io = getIO();
    io.to(`match:${matchId}`).emit('match_ended', { 
      winnerId, 
      reason, 
      payout: result.payout.toString() 
    });
    // Room to emit wallet_updated to the winner: depends on how user rooms are named, 
    // assuming 'user:${winnerId}'
    io.to(`user:${winnerId}`).emit('wallet_updated', { 
      balanceChange: result.payout.toString(),
      matchId
    });
  }
  
  return result;
}

export async function settleGameDraw(matchId, reason) {
  const result = await prisma.$transaction(async (tx) => {
    const match = await tx.match.findUnique({ where: { id: matchId } });
    if (!match || match.status !== 'ACTIVE') return null; // Idempotency gate

    await tx.match.update({ where: { id: matchId }, data: {
      status: 'COMPLETED', endReason: reason, endedAt: new Date()
    }});

    // Refund BOTH players — use lockWalletsInOrder for consistent lock ordering
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
    // Cleanup Redis
    await redis.del(`match:${matchId}`);
    await redis.del(`user:${result.match.playerLightId}:activeMatch`);
    await redis.del(`user:${result.match.playerDarkId}:activeMatch`);
    
    // Notify clients
    const io = getIO();
    io.to(`match:${matchId}`).emit('match_ended', { 
      winnerId: null, 
      reason, 
      payout: result.match.stakeMinorUnits.toString() 
    });
    io.to(`user:${result.match.playerLightId}`).emit('wallet_updated', { 
      balanceChange: result.match.stakeMinorUnits.toString(),
      matchId
    });
    io.to(`user:${result.match.playerDarkId}`).emit('wallet_updated', { 
      balanceChange: result.match.stakeMinorUnits.toString(),
      matchId
    });
  }
  
  return result;
}

export async function settleGameWithRetry(matchId, winnerId, loserId, reason, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await settleGame(matchId, winnerId, loserId, reason);
      return; // Success
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
        await sleep(attempt * 500); // 500ms, 1000ms, 1500ms backoff
      }
    }
  }
}

export async function settleGameDrawWithRetry(matchId, reason, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await settleGameDraw(matchId, reason);
      return; // Success
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
}
