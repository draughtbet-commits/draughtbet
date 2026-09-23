import { postStakeReservation, postStakeRelease } from '../../services/ledgerService.js';
import { recordDailyUsage } from '../../services/dailyUsageService.js';

/**
 * StakeService — V2 stake lifecycle.
 *
 * Owns stake reservation and release. Each player's stake is recorded as a
 * StakeReservation row (RESERVED -> RELEASED / SETTLED) and posted to the
 * double-entry ledger (PLAYER_AVAILABLE -> PLAYER_LOCKED / reverse) in the
 * SAME transaction so a partial match is impossible.
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
export async function reserveStake(tx, { matchId, userId, amountMinorUnits, currency }) {
  const existing = await tx.stakeReservation.findUnique({
    where: { matchId_userId: { matchId, userId } }
  });
  if (existing) return existing;
  const row = await tx.stakeReservation.create({
    data: { matchId, userId, amountMinorUnits, status: 'RESERVED' }
  });
  // Count the committed stake in today's usage bucket only on a fresh reserve,
  // so a replayed funding can never double-count (see reserveStake idempotency).
  if (currency) {
    await recordDailyUsage(tx, { userId, currency, stakeCommittedMinorUnits: amountMinorUnits });
  }
  return row;
}

/**
 * Reserves BOTH player stakes for a funded match inside the caller's
 * transaction:
 *   1. StakeReservation rows (RESERVED) for each player
 *   2. V2 ledger STAKE_RESERVED posting (balanced, idempotent per match)
 *
 * `participants` is [{ userId, currency }] for the two players (light/dark),
 * `wallets` are the pre-locked Wallet rows used to serialize matching funds;
 * if supplied they also provide each participant's currency.
 */
export async function reserveBothStakes(
  tx,
  { matchId, participants, amountMinorUnits, wallets }
) {
  // Validate every participant's wallet is locked BEFORE any write so a partial
  // reservation is impossible. Locking the Wallet rows is what serializes a
  // player's stake funding against withdrawals and sibling fundings.
  const resolved = participants.map(({ userId }) => {
    if (wallets) {
      const wallet = wallets.find((w) => w.userId === userId);
      if (!wallet) throw new Error(`Wallet not locked for userId: ${userId}`);
      return { userId, wallet };
    }
    return { userId, wallet: null };
  });

  const reservedOrders = [];
  const ledgerReservations = [];

  for (const { userId, wallet } of resolved) {
    reservedOrders.push(
      await reserveStake(tx, {
        matchId,
        userId,
        amountMinorUnits,
        currency: wallet?.currency ?? 'NGN'
      })
    );

    ledgerReservations.push({
      userId,
      currency: wallet?.currency ?? 'NGN',
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
 *   2. V2 ledger STAKE_RELEASED posting
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
    if (wallets) {
      const wallet = wallets.find((w) => w.userId === userId);
      if (!wallet) throw new Error(`Wallet not locked for userId: ${userId}`);
      return { userId, wallet };
    }
    return { userId, wallet: null };
  });

  const ledgerReleases = [];

  for (const { userId, wallet } of resolved) {
    ledgerReleases.push({
      userId,
      currency: wallet?.currency ?? 'NGN',
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