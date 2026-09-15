import prisma from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { lockWalletsInOrder, lockWalletForUpdate } from '../../services/matchService.js';
import { postSettlementWin, postSettlementDraw } from '../../services/ledgerService.js';
import { LIVE_STATUSES, isLiveStatus } from '../match/service.js';

/**
 * Settlement V2. Financial settlement leaves the socket layer and lives here:
 * sockets call `SettlementService.settleMatch(matchId, terminalResult)`.
 *
 * One idempotent database transaction:
 *   1. validates the terminal request (membership, durable evidence for
 *      board-derived outcomes, frozen fee from the funding-time snapshot)
 *   2. atomically claims the match LIVE -> SETTLED (the single concurrent gate)
 *   3. posts the winner/draw settlement to the V2 ledger
 *      (`MATCH_SETTLEMENT:{matchId}` idempotency key — a retried settlement can
 *      never credit the winner twice)
 *   4. mirrors the legacy wallet/transaction rows in the same transaction
 *      (temporary bridge until the final read-flip)
 *   5. writes the terminal result record (`MatchSettlement`) and per-player
 *      `MatchReceipt` rows.
 *
 * A replay (match already SETTLED, record present) returns the existing result
 * instead of re-posting — this is what makes settlement idempotent.
 */

// Board-deriveable outcomes (played to a finish) must be reproducible from the
// durable move log. Settlement refuses to claim an outcome that has no durable
// evidence behind it; declaration-based results (resign, forfeit, sweep
// cleanups) carry their own reason and need no play record.
export const BOARD_OUTCOME_REASONS = new Set([
  'NO_LEGAL_MOVES',
  'DRAW_THREEFOLD',
  'DRAW_25_KING_MOVES'
]);

// A settlement is retried up to this many times. Because the claim + posting
// are transactional and idempotent, the winner is credited exactly once no
// matter how many attempts run.
export const DEFAULT_SETTLEMENT_RETRIES = 10;

// Terminal status written by V2 settlement. Legacy COMPLETED/FORFEITED rows
// from pre-refactor settlement remain untouched and stay readable.
export const SETTLED_STATUS = 'SETTLED';

export class OutsiderSettlementError extends Error {
  constructor(message = 'Winner is not a participant of this match') {
    super(message);
    this.name = 'OutsiderSettlementError';
  }
}

export class InvalidSettlementError extends Error {
  constructor(message = 'Invalid settlement request') {
    super(message);
    this.name = 'InvalidSettlementError';
  }
}

export class MatchNotSettleableError extends Error {
  constructor(message = 'Match is not in a settleable state') {
    super(message);
    this.name = 'MatchNotSettleableError';
  }
}

/**
 * Fee per the frozen funding-time snapshot. The schema's MatchSettlement field
 * is named feeSnapshotBps but — like the legacy settlementCommissionPercent it
 * snapshots — it stores whole percent (0-100), never scaled to basis points.
 */
export function resolveFeeBps(tx, match) {
  if (match.settlementCommissionPercent !== null && match.settlementCommissionPercent !== undefined) {
    return match.settlementCommissionPercent;
  }
  // Legacy ACTIVE rows funded before the snapshot column existed have no
  // frozen fee; the current global commission is their only source. New
  // matches always carry a snapshot, so this fallback disappears at the
  // final read-flip and is never consulted for newly funded matches.
  return asyncSettingsLookup(tx);
}

async function asyncSettingsLookup(tx) {
  const settings = await tx.platformSettings.findUnique({ where: { id: 'singleton' } });
  return settings?.commissionPercent;
}

/**
 * Pot / commission / payout from a match stake and a frozen fee percent.
 */
export function computeSettlement(match, commissionPercent) {
  if (!Number.isInteger(commissionPercent) || commissionPercent < 0 || commissionPercent > 100) {
    throw new InvalidSettlementError(`Invalid commission percent: ${commissionPercent}`);
  }
  const pot = BigInt(match.stakeMinorUnits) * 2n;
  const commission = (pot * BigInt(commissionPercent)) / 100n;
  const payout = pot - commission;
  return { pot, commission, payout };
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

function assertTerminalResultShape(match, terminalResult) {
  const { result, winnerId, loserId, endReason } = terminalResult;
  if (!result || !endReason) {
    throw new InvalidSettlementError('Terminal result requires a result kind and an end reason');
  }
  if (result === 'WIN') {
    if (!winnerId) throw new InvalidSettlementError('A decided result requires a winner');
    validateSettlementParticipants(match, winnerId, loserId);
    return { winnerId, loserId: loserId ?? null, endReason };
  }
  if (result === 'DRAW') {
    if (winnerId) throw new InvalidSettlementError('A draw cannot name a winner');
    return { winnerId: null, loserId: null, endReason };
  }
  throw new InvalidSettlementError(`Unknown terminal result kind: ${result}`);
}

async function loadSettlementOrThrow(tx, matchId) {
  const existing = await tx.matchSettlement.findUnique({ where: { matchId } });
  if (!existing) {
    throw new MatchNotSettleableError(`Match ${matchId} is not settleable and has no settlement record`);
  }
  return existing;
}

async function readMatch(tx, matchId) {
  return tx.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      status: true,
      stakeMinorUnits: true,
      playerLightId: true,
      playerDarkId: true,
      settlementCommissionPercent: true
    }
  });
}

/**
 * Idempotent financial settlement of one match. Returns:
 *   { claimed, replayed, payout, commission, match, settlement }
 * where a fresh settlement has claimed:true and a replay has replayed:true.
 * Throws Outsider/InvalidSettlementError for rejectable input and
 * MatchNotSettleableError when the match can never settle (e.g. already
 * released). Nothing is written unless the whole transaction commits.
 */
export async function settleMatch(matchId, terminalResult) {
  return prisma.$transaction(async (tx) => {
    const match = await readMatch(tx, matchId);
    if (!match) throw new MatchNotSettleableError(`Match ${matchId} not found`);

    if (!isLiveStatus(match.status)) {
      return { ...(await replayResponse(tx, matchId, match)), claimed: false, replayed: true };
    }

    const { winnerId, endReason } = assertTerminalResultShape(match, terminalResult);

    // Evidence gate: board-derived outcomes require a durable record of the
    // final move, otherwise the settlement has no history to stand on.
    if (BOARD_OUTCOME_REASONS.has(endReason)) {
      const finalMove = await tx.matchMove.findFirst({
        where: { matchId },
        orderBy: { moveNumber: 'desc' }
      });
      if (!finalMove) {
        throw new InvalidSettlementError('Settlement evidence missing: move log is empty');
      }
    }

    // Frozen fee at funding time; never the live commission for new matches.
    const feeBps = await resolveFeeBps(tx, match);
    const { commission, payout } = computeSettlement(match, feeBps);

    // Atomic claim: the single settlement gate. Exactly one concurrent caller
    // wins; every other contender returns / throws so the retry wrapper can
    // reconcile against the winner's committed record.
    const claimed = await tx.match.updateMany({
      where: { id: matchId, status: { in: LIVE_STATUSES } },
      data: {
        status: SETTLED_STATUS,
        ...(winnerId ? { winnerId } : {}),
        endReason,
        endedAt: new Date()
      }
    });
    if (claimed.count === 0) {
      return { ...(await replayResponse(tx, matchId, match)), claimed: false, replayed: true };
    }

    await postSettlement(tx, matchId, match, {
      kind: winnerId ? 'WIN' : 'DRAW',
      winnerId,
      payout,
      commission
    });
    await mirrorLegacySettlement(tx, match, winnerId, payout);

    const settlement = await tx.matchSettlement.create({
      data: {
        matchId,
        ...(winnerId ? { winnerId } : {}),
        endReason,
        feeSnapshotBps: feeBps,
        netPayoutMinorUnits: payout,
        status: 'SETTLED',
        settledAt: new Date()
      }
    });

    await tx.matchReceipt.createMany({
      data: receiptsFor(match, winnerId, payout, commission)
    });

    logger.info({ matchId, winnerId: winnerId ?? null, payout: payout.toString(), feeBps }, 'Match settled');

    return {
      claimed: true,
      replayed: false,
      payout,
      commission,
      match,
      settlement
    };
  });
}

async function replayResponse(tx, matchId, match) {
  const settlement = await loadSettlementOrThrow(tx, matchId);
  return {
    payout: settlement.netPayoutMinorUnits,
    commission: 2n * BigInt(match.stakeMinorUnits) - settlement.netPayoutMinorUnits,
    match,
    settlement
  };
}

function reservationsFor(match) {
  return [
    { userId: match.playerLightId, currency: 'NGN', amountMinorUnits: BigInt(match.stakeMinorUnits) },
    { userId: match.playerDarkId, currency: 'NGN', amountMinorUnits: BigInt(match.stakeMinorUnits) }
  ];
}

/**
 * Winner transaction:
 *   A locked       -stake
 *   B locked       -stake
 *   winner avail   +netPayout
 *   platform rev   +commission
 *   total                0
 * Draw release: both locked -stake / both available +stake.
 */
async function postSettlement(tx, matchId, match, { kind, winnerId, payout, commission }) {
  const reservations = reservationsFor(match);
  if (kind === 'WIN') {
    return postSettlementWin(tx, matchId, {
      reservations,
      winnerId,
      netPayoutMinorUnits: payout,
      commissionMinorUnits: commission
    });
  }
  return postSettlementDraw(tx, matchId, { reservations });
}

/**
 * Legacy mirror (bridge until the final read-flip): the winner's wallet is
 * credited the net payout / both wallets the stake on a draw, with matching
 * WalletTransaction rows. Financial truth lives in the ledger posting issued
 * in the same transaction.
 */
async function mirrorLegacySettlement(tx, match, winnerId, payout) {
  if (winnerId) {
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
        relatedMatchId: match.id
      }
    });
    return;
  }

  const [w1, w2] = await lockWalletsInOrder(tx, match.playerLightId, match.playerDarkId);
  for (const w of [w1, w2]) {
    await tx.wallet.update({
      where: { id: w.id },
      data: { balanceMinorUnits: { increment: match.stakeMinorUnits } }
    });
    await tx.walletTransaction.create({
      data: {
        walletId: w.id,
        type: 'REFUND',
        amountMinorUnits: match.stakeMinorUnits,
        relatedMatchId: match.id
      }
    });
  }
}

/**
 * Per-player receipts:
 *   WIN  — winner: stake in / net payout out / commission; loser: stake in / 0
 *   DRAW — both: stake in / full stake refund out / 0 fee
 */
function receiptsFor(match, winnerId, payout, commission) {
  const stake = BigInt(match.stakeMinorUnits);
  if (!winnerId) {
    return [
      { matchId: match.id, userId: match.playerLightId, stakeMinorUnits: stake, payoutMinorUnits: stake, feeMinorUnits: 0n },
      { matchId: match.id, userId: match.playerDarkId, stakeMinorUnits: stake, payoutMinorUnits: stake, feeMinorUnits: 0n }
    ];
  }
  const loserId = winnerId === match.playerLightId ? match.playerDarkId : match.playerLightId;
  return [
    { matchId: match.id, userId: winnerId, stakeMinorUnits: stake, payoutMinorUnits: payout, feeMinorUnits: commission },
    { matchId: match.id, userId: loserId, stakeMinorUnits: stake, payoutMinorUnits: 0n, feeMinorUnits: 0n }
  ];
}

export const SettlementService = Object.freeze({
  settleMatch,
  resolveFeeBps,
  computeSettlement,
  liveStatuses: LIVE_STATUSES
});