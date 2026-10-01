import logger from '../utils/logger.js';
import { ensureUserAccounts, postLedgerTransaction } from './ledgerService.js';

/**
 * The stake-lock invariant.
 *
 * `PLAYER_LOCKED` is not a counter the app maintains; it is a ledger balance
 * derived from posted transactions. The only legitimate way for it to hold a
 * player's money is a stake reserved against a match that is still live:
 *
 *     PLAYER_LOCKED == SUM(reservation.amount)
 *                     over reservations with status RESERVED
 *                     whose match is still live
 *
 * Anything else is money the platform is holding without a claim against it:
 * the player sees it as "locked", cannot spend it, and no payout or release
 * path will ever return it. That is why it has to be checked from the server
 * rather than inferred on the client.
 *
 * Two distinct defects break the invariant, and they need different handling:
 *
 *   1. A reservation row left in RESERVED after its match reached a terminal
 *      status. The ledger may already be balanced, so this is bookkeeping
 *      residue -- but it makes "my active reservations" queries overstate what
 *      is genuinely locked.
 *   2. A stake that was debited from available and credited to locked, whose
 *      release never posted. This is the real leak: the funds are stranded.
 *
 * Audit is always safe. Repair writes to the ledger and is therefore opt-in.
 */

const LIVE_STATUSES = ['OPEN', 'FUNDED', 'READY', 'IN_PLAY', 'ACTIVE'];

const lockedBalance = async (client, userId, currency = 'NGN') => {
  const account = await client.ledgerAccount.findFirst({
    where: { userId, type: 'PLAYER_LOCKED', currency },
    select: { id: true },
  });
  if (!account) return 0n;
  const sum = await client.ledgerEntry.aggregate({
    where: { accountId: account.id },
    _sum: { amountMinorUnits: true },
  });
  return BigInt(sum._sum.amountMinorUnits ?? 0);
};

/**
 * Compares the ledger lock against live reservations for one player.
 * Read-only: safe to call from a request handler or a sweep.
 */
export async function auditStakeLocks(client, userId, { currency = 'NGN' } = {}) {
  const reservations = await client.stakeReservation.findMany({
    where: { userId, status: 'RESERVED' },
    select: { matchId: true, amountMinorUnits: true },
  });

  let expected = 0n;
  let orphanCandidates = [];
  if (reservations.length > 0) {
    const matches = await client.match.findMany({
      where: { id: { in: reservations.map((r) => r.matchId) } },
      select: { id: true, status: true },
    });
    const statusById = new Map(matches.map((m) => [m.id, m.status]));
    const stale = [];
    for (const r of reservations) {
      const status = statusById.get(r.matchId);
      if (status && LIVE_STATUSES.includes(status)) {
        expected += BigInt(r.amountMinorUnits);
      } else {
        stale.push({ matchId: r.matchId, amountMinorUnits: String(r.amountMinorUnits), matchStatus: status ?? null });
      }
    }
    orphanCandidates = stale;
  }

  const actual = await lockedBalance(client, userId, currency);
  const stranded = actual - expected;

  return {
    userId,
    expectedMinorUnits: expected,
    actualMinorUnits: actual,
    // Positive: the platform holds more than it has a claim on. Negative: a live
    // reservation has no matching lock, which would let a stake be spent twice.
    strandedMinorUnits: stranded,
    staleReservations: orphanCandidates,
    balanced: stranded === 0n && orphanCandidates.length === 0,
  };
}

/**
 * Restores the invariant for one player.
 *
 * - Stale RESERVED rows are closed out to RELEASED. This touches no money: by
 *   the time a match is terminal its lock has already been released or settled,
 *   so the row is a leftover record, not a live claim.
 * - A stranded positive lock is returned to the player: the held amount leaves
 *   PLAYER_LOCKED and returns to PLAYER_AVAILABLE, restoring their spendable
 *   balance.
 *
 * Idempotent: a balanced player is a no-op, and the ledger post is keyed on the
 * current balance so a repeated run cannot pay the same orphan twice.
 */
export async function reconcileStakeLocks(client, userId, { currency = 'NGN', actorId = null } = {}) {
  const audit = await auditStakeLocks(client, userId, { currency });

  if (audit.staleReservations.length > 0) {
    await client.stakeReservation.updateMany({
      where: { userId, status: 'RESERVED', matchId: { in: audit.staleReservations.map((s) => s.matchId) } },
      data: { status: 'RELEASED' },
    });
    logger.warn(
      { userId, rows: audit.staleReservations.length },
      'Stake lock reconciliation closed stale RESERVED rows on terminal matches',
    );
  }

  if (audit.strandedMinorUnits <= 0n) {
    return { ...audit, repairedMinorUnits: 0n, staleRowsClosed: audit.staleReservations.length };
  }

  const amount = audit.strandedMinorUnits;
  await client.$transaction(async (tx) => {
    const accounts = await ensureUserAccounts(tx, userId, currency);
    await postLedgerTransaction(tx, {
      type: 'STAKE_RELEASED',
      description: `Stranded stake lock returned to player ${userId}`,
      // Keyed on the amount being returned: re-running after a successful
      // repair finds nothing stranded and never reaches this path.
      idempotencyKey: `lock-reconcile:${userId}:${currency}:${amount.toString()}`,
      metadata: {
        userId,
        currency,
        reason: 'stranded_stake_lock',
        actorId,
        strandedMinorUnits: amount.toString(),
        staleMatchIds: audit.staleReservations.map((s) => s.matchId),
      },
      entries: [
        { accountId: accounts.PLAYER_LOCKED.id, amountMinorUnits: -amount },
        { accountId: accounts.PLAYER_AVAILABLE.id, amountMinorUnits: amount },
      ],
    });
  });

  logger.warn(
    { userId, amountMinorUnits: amount.toString() },
    'Stake lock reconciliation returned a stranded lock to the player',
  );

  return { ...audit, repairedMinorUnits: amount, staleRowsClosed: audit.staleReservations.length };
}

/**
 * Players worth auditing: anyone holding a RESERVED row, plus anyone whose lock
 * balance is non-zero. Cheap enough to sweep, and it catches the "lock without
 * any reservation at all" case that a reservation-only query would miss.
 */
export async function findStakeLockAuditCandidates(client) {
  const [reserved, locked] = await Promise.all([
    client.stakeReservation.findMany({
      where: { status: 'RESERVED' },
      select: { userId: true },
      distinct: ['userId'],
    }),
    client.ledgerAccount.findMany({
      where: { type: 'PLAYER_LOCKED' },
      select: { userId: true },
    }),
  ]);
  const ids = new Set(reserved.map((r) => r.userId).filter(Boolean));
  for (const acc of locked) if (acc.userId) ids.add(acc.userId);
  return [...ids];
}