import crypto from 'crypto';
import prisma from '../utils/db.js';
import { assertEligibleForMoney } from './eligibilityService.js';
import { DEFAULT_TIME_CONTROL_SECONDS } from '../sockets/timeControl.js';
import {
  createMatch,
  transitionMatch,
  hasPreterminalMatchForPlayers
} from '../modules/match/service.js';
import { reserveBothStakes } from '../modules/stake/service.js';
import { getLedgerAvailable } from './ledgerService.js';

export class InsufficientFundsError extends Error {
  constructor(message = 'Insufficient funds') {
    super(message);
    this.name = 'InsufficientFundsError';
  }
}

export class InvalidTierError extends Error {
  constructor(message = 'Invalid tier') {
    super(message);
    this.name = 'InvalidTierError';
  }
}

export class IdenticalPlayersError extends Error {
  constructor(message = 'Players must be distinct') {
    super(message);
    this.name = 'IdenticalPlayersError';
  }
}

export class ActiveMatchError extends Error {
  constructor(message = 'Player already has an active match') {
    super(message);
    this.name = 'ActiveMatchError';
  }
}

/**
 * Locks one wallet row (by userId) until the transaction ends, so money
 * operations touching the same wallet serialize against each other.
 */
export async function lockWalletForUpdate(tx, userId) {
  const rows = await tx.$queryRaw`SELECT * FROM "Wallet" WHERE "userId" = ${userId} FOR UPDATE`;
  if (!rows || rows.length === 0) throw new Error('Wallet not found');
  return rows[0];
}

/**
 * Locks wallets in ascending userId order to prevent deadlocks.
 */
export async function lockWalletsInOrder(tx, idA, idB) {
  const sorted = [idA, idB].sort();
  // We use queryRaw to lock the rows
  const w1 = await tx.$queryRaw`SELECT * FROM "Wallet" WHERE "userId" = ${sorted[0]} FOR UPDATE`;
  const w2 = await tx.$queryRaw`SELECT * FROM "Wallet" WHERE "userId" = ${sorted[1]} FOR UPDATE`;
  
  if (!w1 || w1.length === 0) throw new Error(`Wallet not found for userId: ${sorted[0]}`);
  if (!w2 || w2.length === 0) throw new Error(`Wallet not found for userId: ${sorted[1]}`);
  
  return [w1[0], w2[0]];
}

export function getStakeForTier(settings, tier) {
  const key = `${tier.toLowerCase()}StakeMinP`;
  const val = settings[key];
  if (val === undefined || val === null) {
    throw new InvalidTierError(`Invalid tier: ${tier}`);
  }
  return BigInt(val);
}

/**
 * Core of stake funding, meant to run inside an interactive transaction (`tx`).
 * Locks both wallets, verifies affordability, snapshots fee terms, creates the
 * canonical OPEN match with both participants, reserves both stakes
 * (StakeReservation rows + legacy Wallet debit + V2 ledger STAKE_LOCK mirror)
 * and lands at FUNDED. Shared by `debitStakes` (matchmaking) and
 * `acceptCallout` so a callout is claimed and its funds committed atomically.
 */
export const createMatchWithStakes = async (tx, player1Id, player2Id, stakeMinorUnits, stakeTier) => {
  if (player1Id === player2Id) {
    throw new IdenticalPlayersError('A player cannot fund a match against themselves');
  }

  // Eligibility is checked before any wallet is locked: each player must have
  // server-verified country evidence, be an adult, not be banned or
  // self-excluded, not be on a timeout, and stay within their safer-play stake
  // limit. This covers both matchmaking (queued worker) and call-out
  // acceptances. KYC is deliberately NOT required here — it gates only money
  // leaving the platform.
  const stakeAmount = BigInt(stakeMinorUnits);
  await assertEligibleForMoney(tx, player1Id, { enforceTimeout: true, stakeMinorUnits: stakeAmount });
  await assertEligibleForMoney(tx, player2Id, { enforceTimeout: true, stakeMinorUnits: stakeAmount });

  // 1. Lock both wallets (ordered by ascending userId to prevent deadlocks)
  const [w1, w2] = await lockWalletsInOrder(tx, player1Id, player2Id);

  // 2. Active-match reservation: a player may hold exactly one pre-terminal
  //    match at a time. The wallet row locks above serialize concurrent
  //    fundings of the same player, so this check-and-create is atomic enough —
  //    the second contender sees the first one's committed match and refuses
  //    here. This is the single choke point for every funding path (matchmaking
  //    worker and call-out accept), so no same-user pair can ever commit twice.
  if (await hasPreterminalMatchForPlayers(tx, [player1Id, player2Id])) {
    throw new ActiveMatchError('A player already has an active match');
  }

  // 3. Verify BOTH players can afford the stake from the V2 ledger
  //    (PLAYER_AVAILABLE), still under the wallet row locks so a concurrent
  //    funding of the same player serializes against this check.
  const available1 = await getLedgerAvailable(tx, player1Id, w1.currency ?? 'NGN');
  const available2 = await getLedgerAvailable(tx, player2Id, w2.currency ?? 'NGN');
  if (available1 < stakeAmount || available2 < stakeAmount) {
    throw new InsufficientFundsError('Insufficient funds for stake');
  }

  // 4. Snapshot the accepted fee terms and time control before any match exists.
  const settings = await tx.platformSettings.findUnique({
    where: { id: 'singleton' }
  });
  if (!settings) throw new Error('Platform settings not configured');
  const commissionPercent = settings.commissionPercent;
  if (!Number.isInteger(commissionPercent) || commissionPercent < 0 || commissionPercent > 100) {
    throw new Error(`Invalid commissionPercent snapshot: ${commissionPercent}`);
  }
  const timeControlSeconds = settings.timeControlSeconds ?? DEFAULT_TIME_CONTROL_SECONDS;
  if (!Number.isInteger(timeControlSeconds) || timeControlSeconds < 1) {
    throw new Error(`Invalid timeControlSeconds snapshot: ${timeControlSeconds}`);
  }

  // 5. Generate match ID upfront so WalletTransactions can reference it
  const matchId = crypto.randomUUID();

  // 6. Create the canonical Match (OPEN) with both participants and the frozen
  //    commercial/game terms. No balances are touched here.
  const match = await createMatch(tx, {
    matchId,
    playerLightId: player1Id,
    playerDarkId: player2Id,
    tier: stakeTier,
    stakeMinorUnits: stakeAmount,
    commissionPercent,
    timeControlSeconds,
    currency: w1.currency ?? 'NGN'
  });

  // 7. Reserve both stakes: StakeReservation rows + legacy Wallet debit (the
  //    live read source until the final read-flip) + V2 ledger STAKE_LOCK
  //    mirror, all in the same tx so a partial match is impossible.
  await reserveBothStakes(tx, {
    matchId,
    participants: [
      { userId: player1Id },
      { userId: player2Id }
    ],
    amountMinorUnits: stakeAmount,
    wallets: [w1, w2]
  });

  // 8. Both stakes are now reserved: OPEN -> FUNDED.
  const funded = await transitionMatch(tx, matchId, 'FUNDED');

  // 9. Record the durable activation intent in the same transaction, so a crash
  //    after commit can never leave funds reserved for a match Redis never saw.
  //    The recovery sweep replays this into Redis idempotently, or releases it.
  await tx.gameOutbox.create({ data: {
    matchId,
    player1Id,
    player2Id,
    tier: stakeTier,
    stakeMinorUnits: stakeAmount,
    status: 'PENDING'
  }});

  return funded;
};

/**
 * Public entry for matchmaking: opens its own transaction around
 * `createMatchWithStakes`.
 */
export const debitStakes = async (player1Id, player2Id, stakeMinorUnits, stakeTier) => {
  return await prisma.$transaction(async (tx) => {
    return createMatchWithStakes(tx, player1Id, player2Id, stakeMinorUnits, stakeTier);
  });
};
