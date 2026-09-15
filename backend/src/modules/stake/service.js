import { postStakeReservation, postStakeRelease } from '../../services/ledgerService.js';

/**
 * StakeService — V2 stake lifecycle.
 *
 * Owns stake reservation and release. Each player's stake is recorded as a
 * StakeReservation row (RESERVED -> RELEASED / SETTLED), mirrored into the
 * double-entry ledger (PLAYER_AVAILABLE -> PLAYER_LOCKED / reverse) and, until
 * the final read-flip, kept in lockstep with the legacy Wallet debit/refund
 * in the SAME transaction so a partial match is impossible.
 *
 * Responsibilities:
 *   - idempotency per matchId:userId (a replay never double-reserves)
 *   - release only a permitted reservation; a release is terminal for the row
 *   - NEVER settle a payout itself (that lives in modules/settlement)
 *
 * Balance math is BigInt-in everywhere. These helpers expect the caller to
 * have already locked the wallet rows (lockWalletsInOrder) so money moves
 * serialize against withdrawals and sibling fundings.
 */
export class StakeReservationAlreadySettledError extends Error {
  constructor(message = 'Stake reservation is already settled') {
    super(message);
    this.name = 'StakeReservationAlreadySettledError';
  }
}

/**
 * Creates (or returns) the RESERVED StakeReservation row for one player.
 * Idempotent per [matchId, userId]: an existing row is returned untouched so a
 * replayed funding can never double-reserve a player.
 */
export async function reserveStake(tx, { matchId, userId, amountMinorUnits }) {
  const existing = await tx.stakeReservation.findUnique({
    where: { matchId_userId: { matchId, userId } }
  });
  if (existing) return existing;
  return await tx.stakeReservation.create({
    data: { matchId, userId, amountMinorUnits, status: 'RESERVED' }
  });
}

/**
 * Reserves BOTH player stakes for a funded match inside the caller's
 * transaction:
 *   1. StakeReservation rows (RESERVED) for each player
 *   2. legacy Wallet debit + STAKE walletTransaction (read-source bridge)
 *   3. V2 ledger STAKE_LOCK mirror (balanced, idempotent per match)
 *
 * `participants` is [{ userId, currency }] for the two players (light/dark),
 * `wallets` are the pre-locked Wallet rows used for the legacy debit; each
 * wallet carries one participant's currency.
 */
export async function reserveBothStakes(
  tx,
  { matchId, participants, amountMinorUnits, wallets }
) {
  // Validate every participant's wallet is locked BEFORE any write so a partial
  // reservation is impossible.
  const resolved = participants.map(({ userId }) => {
    const wallet = wallets.find((w) => w.userId === userId);
    if (!wallet) throw new Error(`Wallet not locked for userId: ${userId}`);
    return { userId, wallet };
  });

  const reservedOrders = [];
  const ledgerReservations = [];

  for (const { userId, wallet } of resolved) {
    reservedOrders.push(
      await reserveStake(tx, { matchId, userId, amountMinorUnits })
    );

    // Legacy mirror debit — debit-before-credit ordering, same tx.
    await tx.wallet.update({
      where: { id: wallet.id },
      data: { balanceMinorUnits: { decrement: amountMinorUnits } }
    });
    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: 'STAKE',
        amountMinorUnits: -amountMinorUnits,
        relatedMatchId: matchId
      }
    });

    ledgerReservations.push({
      userId,
      currency: wallet.currency ?? 'NGN',
      amountMinorUnits
    });
  }

  await postStakeReservation(tx, matchId, ledgerReservations);
  return reservedOrders;
}

/**
 * Releases BOTH player stakes when a match is abandoned before it ever becomes
 * playable (activation failure / allowed cancellation). Reverses the reserve:
 *   1. StakeReservation rows RESERVED -> RELEASED
 *   2. legacy Wallet credit (REFUND walletTransaction)
 *   3. V2 ledger STAKE_RELEASE mirror
 *
 * Idempotent: the claim token + the ledger's unique stake-release key, and the
 * RESERVED-only guard on the reservation rows, prevent a double release.
 */
export async function releaseStakes(
  tx,
  { matchId, participants, amountMinorUnits, wallets }
) {
  // Validate every participant's wallet is locked BEFORE any write.
  const resolved = participants.map(({ userId }) => {
    const wallet = wallets.find((w) => w.userId === userId);
    if (!wallet) throw new Error(`Wallet not locked for userId: ${userId}`);
    return { userId, wallet };
  });

  const ledgerReleases = [];

  for (const { userId, wallet } of resolved) {
    await tx.wallet.update({
      where: { id: wallet.id },
      data: { balanceMinorUnits: { increment: amountMinorUnits } }
    });
    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: 'REFUND',
        amountMinorUnits,
        relatedMatchId: matchId,
        status: 'COMPLETED'
      }
    });

    ledgerReleases.push({
      userId,
      currency: wallet.currency ?? 'NGN',
      amountMinorUnits
    });
  }

  await tx.stakeReservation.updateMany({
    where: {
      matchId,
      userId: { in: participants.map((p) => p.userId) },
      status: 'RESERVED'
    },
    data: { status: 'RELEASED' }
  });

  await postStakeRelease(tx, matchId, ledgerReleases);
}

export default {
  reserveStake,
  reserveBothStakes,
  releaseStakes,
  StakeReservationAlreadySettledError
};