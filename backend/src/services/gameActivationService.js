import crypto from 'crypto';
import prisma from '../utils/db.js';
import redis from '../utils/redis.js';
import logger from '../utils/logger.js';
import { initializeGame } from '../sockets/gameManager.js';
import { lockWalletsInOrder } from './matchService.js';
import { releaseStakes } from '../modules/stake/service.js';
import { transitionMatch } from '../modules/match/service.js';

// Lease length for an activation claim. All claims are short (an idempotent
// Redis init + a boolean mark); a lease this long is only meant to outlive the
// worst non-hanging outage, so a crashed owner is reclaimed quickly.
export const ACTIVATING_LEASE_MS = 30_000;

// A match that cannot become playable after this many attempts is abandoned:
// the release path refunds both stakes exactly once instead of leaving an
// orphaned reservation.
export const MAX_ACTIVATION_ATTEMPTS = 5;

// Claims PENDING or ACTIVATING rows whose lease is free (never claimed or
// expired). The atomic UPDATE is the CAS: exactly one actor can hold the claim
// token at a time, so inline activation and the recovery sweep serialize.
async function takeOutboxClaim(outboxId) {
  const claimToken = crypto.randomUUID();
  const rows = await prisma.$queryRaw`
    UPDATE "GameOutbox"
    SET "claimToken" = ${claimToken},
        "claimExpiresAt" = NOW() + (${ACTIVATING_LEASE_MS / 1000}::int) * INTERVAL '1 second',
        "status" = 'ACTIVATING',
        "attempts" = "attempts" + 1
    WHERE "id" = ${outboxId}
      AND "status" IN ('PENDING', 'ACTIVATING')
      AND ("claimExpiresAt" IS NULL OR "claimExpiresAt" < NOW())
    RETURNING "id", "matchId", "player1Id", "player2Id", "tier", "stakeMinorUnits", "attempts"
  `;
  if (!rows || rows.length === 0) return null;
  return { ...rows[0], claimToken };
}

async function currentStatus(outboxId) {
  const row = await prisma.gameOutbox.findUnique({
    where: { id: outboxId },
    select: { status: true }
  });
  return row?.status ?? null;
}

async function markActivated(outbox) {
  const count = await prisma.gameOutbox.updateMany({
    where: { id: outbox.id, claimToken: outbox.claimToken },
    data: { status: 'ACTIVATED', claimToken: null, claimExpiresAt: null }
  });
  return count.count === 1;
}

async function recordFailure(outbox, err) {
  await prisma.gameOutbox.updateMany({
    where: { id: outbox.id },
    data: {
      claimToken: null,
      claimExpiresAt: null,
      lastError: String(err?.message ?? err).slice(0, 2000)
    }
  });
}

/**
 * Makes one match playable from its durable outbox record, idempotently.
 * Used inline by the funding paths (call-out accept, matchmaking worker) and
 * by the recovery sweep. Never re-debits; if Redis init fails the caller keeps
 * the record PENDING/ACTIVATING and the sweep retries or releases.
 */
export const finalizeMatchActivation = async (outboxId) => {
  const status = await currentStatus(outboxId);
  if (status === 'ACTIVATED' || status === 'RELEASED') return status;

  const outbox = await takeOutboxClaim(outboxId);
  if (!outbox) return currentStatus(outboxId);

  try {
    // initializeGame is idempotent: it reconstructs fresh Redis state when the
    // key is absent and only repairs the participant pointers when it exists.
    // It also performs the server-authoritative start: the Match row advances
    // FUNDED/READY -> IN_PLAY (idempotent CAS), so the game clock and the
    // settlement gate agree the match is live.
    await initializeGame(outbox.matchId, outbox.player1Id, outbox.player2Id, outbox.tier);
    await markActivated(outbox);
    return 'ACTIVATED';
  } catch (err) {
    await recordFailure(outbox, err);
    logger.warn(
      { err, outboxId, matchId: outbox.matchId, attempts: outbox.attempts },
      'Game activation failed; a later attempt or the release path will finish it'
    );
    throw err;
  }
};

/**
 * Abandons a match that cannot be activated and lets both players recoup their
 * stake. Runs atomically (wallets locked, refunds ledgered, match and outbox
 * finalized) and is guarded by the claim token + the unique
 * (relatedMatchId, REFUND, walletId) ledger index, so it can never refund twice.
 */
export const releaseMatch = async (outboxId) => {
  const outbox = await takeOutboxClaim(outboxId);
  if (!outbox) return null;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const [w1, w2] = await lockWalletsInOrder(tx, outbox.player1Id, outbox.player2Id);
      const stakeAmount = BigInt(outbox.stakeMinorUnits);

      // A release is only legal before the game ever became live: a player can
      // recoup their stake from FUNDED (activation failed) or READY (never
      // started), never after IN_PLAY. The guard runs inside the tx before any
      // refund so an invalid release rolls back with no money moved.
      await transitionMatch(tx, outbox.matchId, 'RELEASED');

      // Legacy Wallet refund + StakeReservation rows RESERVED -> RELEASED + the
      // V2 ledger STAKE_RELEASE mirror, all in the same tx.
      await releaseStakes(tx, {
        matchId: outbox.matchId,
        participants: [
          { userId: outbox.player1Id },
          { userId: outbox.player2Id }
        ],
        amountMinorUnits: stakeAmount,
        wallets: [w1, w2]
      });

      await tx.match.update({
        where: { id: outbox.matchId },
        data: { endReason: 'activation_failed', endedAt: new Date() }
      });

      await tx.gameOutbox.update({
        where: { id: outbox.id },
        data: { status: 'RELEASED', claimToken: null, claimExpiresAt: null }
      });

      return { matchId: outbox.matchId, released: true };
    });

    logger.info({ outboxId, matchId: outbox.matchId }, 'Match released and both stakes refunded');
    return result;
  } catch (err) {
    await recordFailure({ id: outbox.id }, err);
    throw err;
  }
};