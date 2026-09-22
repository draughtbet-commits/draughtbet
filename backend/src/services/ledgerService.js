import { randomUUID } from 'node:crypto';
import prisma from '../utils/db.js';
import logger from '../utils/logger.js';

/**
 * Double-entry ledger (V2). Every money movement is a LEDGER TRANSACTION with
 * at least two balanced LEDGER ENTRIES whose signed amounts sum to zero.
 *
 * Account types:
 *   PLAYER_AVAILABLE            — spendable player balance (== legacy wallet after backfill)
 *   PLAYER_LOCKED               — stakes locked against a funded match
 *   PLAYER_WITHDRAWAL_PENDING   — funds reserved against a pending withdrawal
 *   PLATFORM_REVENUE            — platform commission (system singleton)
 *   SYSTEM_OPENING_CLEARING     — contra account for legacy-balance backfill (system singleton)
 *   SUSPENSE                    — unowned residual holding, where entries without an
 *                                 owning player/party settle before final posting
 *
 * Conventions:
 *   - LedgerEntry.amountMinorUnits is SIGNED: positive = credit, negative = debit.
 *   - Every transaction is balanced: sum(entries.amountMinorUnits) === 0n.
 *   - LedgerTransaction.idempotencyKey is unique; a replay returns the original
 *     transaction instead of posting twice (checked first, and by P2002 on race).
 *   - Money is always BigInt-in, string-out; no floats anywhere.
 */

export const PLAYER_ACCOUNT_TYPES = Object.freeze([
  'PLAYER_AVAILABLE',
  'PLAYER_LOCKED',
  'PLAYER_WITHDRAWAL_PENDING'
]);

export const SYSTEM_ACCOUNT_TYPES = Object.freeze([
  'PLATFORM_REVENUE',
  'SYSTEM_OPENING_CLEARING',
  'SUSPENSE',
  'CUSTOMER_LIABILITY'
]);

export const SYSTEM_ACCOUNT_ID = (type, currency) => `system:${type}:${currency}`;

// Valid postable types: legacy internal names (retained additively for
// pre-remap rows and tests) plus the contract names (decisions §10) that all
// NEW postings must use.
const LEDGER_ENTRY_TYPES = new Set([
  'DEPOSIT_CREDIT',
  'STAKE_LOCK',
  'STAKE_RELEASE',
  'SETTLEMENT_PAYOUT',
  'WITHDRAWAL_RESERVE',
  'WITHDRAWAL_COMPLETE',
  'WITHDRAWAL_RELEASE',
  'ADJUSTMENT',
  'DEPOSIT_PENDING',
  'DEPOSIT_CONFIRMED',
  'DEPOSIT_FAILED',
  'DEPOSIT_REVERSED',
  'STAKE_RESERVED',
  'STAKE_RELEASED',
  'MATCH_SETTLED_WIN',
  'MATCH_SETTLED_LOSS',
  'MATCH_SETTLED_DRAW',
  'WITHDRAWAL_PENDING',
  'WITHDRAWAL_CONFIRMED',
  'WITHDRAWAL_FAILED',
  'WITHDRAWAL_REVERSED',
  'WITHDRAWAL_RELEASED',
  'ADJUSTMENT_CREDIT',
  'ADJUSTMENT_DEBIT'
]);

export class InvalidAmountError extends Error {
  constructor(message = 'Invalid ledger amount') {
    super(message);
    this.name = 'InvalidAmountError';
  }
}

export class UnbalancedPostingError extends Error {
  constructor(message = 'Ledger transaction entries must sum to a net of zero') {
    super(message);
    this.name = 'UnbalancedPostingError';
  }
}

export class InsufficientFundsError extends Error {
  constructor(message = 'Insufficient available balance') {
    super(message);
    this.name = 'InsufficientFundsError';
  }
}

const assertAmount = (amount) => {
  if (typeof amount !== 'bigint' || amount === 0n) {
    throw new InvalidAmountError();
  }
  return amount;
};

/**
 * Resolves (create-if-missing) a single ledger account for a user.
 *
 * Uses a native `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` rather than
 * Prisma's `upsert`: inside concurrent interactive transactions Prisma's
 * upsert can degrade to a check-then-insert and raise P2002 when two deposits
 * for the same fresh user race to create the account. The native statement is
 * atomic at the database level and always returns the surviving row.
 */
export async function getOrCreateUserAccount(tx, userId, type, currency = 'NGN') {
  if (!PLAYER_ACCOUNT_TYPES.includes(type)) {
    throw new Error(`Cannot create ${type} as a user account`);
  }
  const rows = await tx.$queryRaw`
    INSERT INTO "LedgerAccount" ("id", "userId", "type", "currency")
    VALUES (${randomUUID()}, ${userId}, ${type}::"AccountType", ${currency}::"Currency")
    ON CONFLICT ("userId", "type", "currency")
    DO UPDATE SET "currency" = EXCLUDED."currency"
    RETURNING *
  `;
  return rows[0];
}

export async function ensureUserAccounts(tx, userId, currency = 'NGN') {
  const results = await Promise.all(
    PLAYER_ACCOUNT_TYPES.map((type) => getOrCreateUserAccount(tx, userId, type, currency))
  );
  return Object.fromEntries(
    PLAYER_ACCOUNT_TYPES.map((type, i) => [type, results[i]])
  );
}

/**
 * Resolves (create-if-missing) a system singleton account. System accounts get
 * a deterministic id (`system:{TYPE}:{CURRENCY}`) because the schema's unique
 * [userId, type, currency] treats NULL user ids as distinct, so it cannot
 * enforce uniqueness by itself. Like user accounts, the insert is a native
 * atomic upsert so concurrent first-time postings cannot race.
 */
export async function ensureSystemAccount(tx, type, currency = 'NGN') {
  if (!SYSTEM_ACCOUNT_TYPES.includes(type)) {
    throw new Error(`Cannot create ${type} as a system account`);
  }
  const id = SYSTEM_ACCOUNT_ID(type, currency);
  const rows = await tx.$queryRaw`
    INSERT INTO "LedgerAccount" ("id", "userId", "type", "currency")
    VALUES (${id}, NULL, ${type}::"AccountType", ${currency}::"Currency")
    ON CONFLICT ("id")
    DO UPDATE SET "currency" = EXCLUDED."currency"
    RETURNING *
  `;
  return rows[0];
}

function assertBalanced(entries) {
  if (!Array.isArray(entries) || entries.length < 2) {
    throw new UnbalancedPostingError(
      'A ledger transaction requires at least two entries'
    );
  }
  let net = 0n;
  for (const entry of entries) {
    if (!entry || typeof entry.accountId !== 'string' || entry.accountId === '') {
      throw new Error('Each ledger entry requires a non-empty accountId');
    }
    const amount = assertAmount(entry.amountMinorUnits);
    net += amount;
  }
  if (net !== 0n) {
    throw new UnbalancedPostingError();
  }
}

/**
 * Posts a balanced ledger transaction and its entries inside the caller's
 * transaction. Returns `{ transaction, entries, replayed }`.
 *
 * Idempotent when idempotencyKey is supplied: an existing transaction with the
 * same key is returned as `replayed: true` (checked first, then recovered from
 * a P2002 race where a concurrent identical post won).
 */
export async function postLedgerTransaction(
  tx,
  { type, description, idempotencyKey, relatedMatchId, metadata, entries }
) {
  if (!LEDGER_ENTRY_TYPES.has(type)) {
    throw new Error(`Unknown ledger entry type: ${type}`);
  }
  if (entries !== undefined) {
    assertBalanced(entries);
  }

  if (idempotencyKey !== undefined && idempotencyKey !== null) {
    const existing = await tx.ledgerTransaction.findUnique({
      where: { idempotencyKey },
      include: { entries: true }
    });
    if (existing) {
      logger.info({ idempotencyKey, type }, 'Ledger transaction replayed from idempotency key');
      return { transaction: existing, entries: existing.entries, replayed: true };
    }
  }

  try {
    const transaction = await tx.ledgerTransaction.create({
      data: {
        type,
        ...(description !== undefined ? { description } : {}),
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        ...(relatedMatchId !== undefined ? { relatedMatchId } : {}),
        ...(metadata !== undefined ? { metadata } : {})
      }
    });

    const created = [];
    for (const entry of entries) {
      created.push(
        await tx.ledgerEntry.create({
          data: {
            transactionId: transaction.id,
            accountId: entry.accountId,
            amountMinorUnits: assertAmount(entry.amountMinorUnits)
          }
        })
      );
    }

    return { transaction, entries: created, replayed: false };
  } catch (error) {
    if (error?.code === 'P2002' && idempotencyKey !== undefined) {
      const winner = await tx.ledgerTransaction.findUnique({
        where: { idempotencyKey },
        include: { entries: true }
      });
      if (winner) {
        logger.info({ idempotencyKey, type }, 'Ledger transaction returned on concurrent duplicate');
        return { transaction: winner, entries: winner.entries, replayed: true };
      }
    }
    throw error;
  }
}

/**
 * Posts the two-player STAKE_LOCK for a funded match inside the caller's tx:
 *   PLAYER_AVAILABLE  -amount   (each player)
 *   PLAYER_LOCKED     +amount   (each player)
 * Net zero across the two users. Idempotent per match via `stake-lock:{matchId}`.
 * This is the V2 reservation mirror; the legacy Wallet decrement stays as the
 * read-source bridge until the final read-flip milestone.
 */
export async function postStakeReservation(tx, matchId, reservations) {
  const entries = [];
  for (const r of reservations) {
    const accounts = await ensureUserAccounts(tx, r.userId, r.currency ?? 'NGN');
    entries.push(
      { accountId: accounts.PLAYER_AVAILABLE.id, amountMinorUnits: -r.amountMinorUnits },
      { accountId: accounts.PLAYER_LOCKED.id, amountMinorUnits: r.amountMinorUnits }
    );
  }
  return postLedgerTransaction(tx, {
    type: 'STAKE_RESERVED',
    description: `Stakes locked for match ${matchId}`,
    idempotencyKey: `stake-lock:${matchId}`,
    relatedMatchId: matchId,
    metadata: { players: reservations.map((r) => r.userId) },
    entries
  });
}

/**
 * Reverses the two-player stake lock when a match is released before it ever
 * becomes playable (activation failure / allowed cancellation):
 *   PLAYER_LOCKED     -amount   (each player)
 *   PLAYER_AVAILABLE  +amount   (each player)
 * Idempotent per match via `stake-release:{matchId}`.
 */
export async function postStakeRelease(tx, matchId, reservations) {
  const entries = [];
  for (const r of reservations) {
    const accounts = await ensureUserAccounts(tx, r.userId, r.currency ?? 'NGN');
    entries.push(
      { accountId: accounts.PLAYER_LOCKED.id, amountMinorUnits: -r.amountMinorUnits },
      { accountId: accounts.PLAYER_AVAILABLE.id, amountMinorUnits: r.amountMinorUnits }
    );
  }
  return postLedgerTransaction(tx, {
    type: 'STAKE_RELEASED',
    description: `Stakes released for match ${matchId}`,
    idempotencyKey: `stake-release:${matchId}`,
    relatedMatchId: matchId,
    metadata: { players: reservations.map((r) => r.userId) },
    entries
  });
}

/**
 * Posts the winner-payout settlement for a decided match:
 *   PLAYER_LOCKED      -amount   (each player — stake leaves the lock)
 *   PLAYER_AVAILABLE   +netPayout (winner's pot minus commission)
 *   PLATFORM_REVENUE   +commission
 * Net zero: -2s + (2s - c) + c = 0. Idempotent per match via
 * `MATCH_SETTLEMENT:{matchId}`, so a retried settlement never credits twice.
 */
export async function postSettlementWin(
  tx,
  matchId,
  { reservations, winnerId, netPayoutMinorUnits, commissionMinorUnits }
) {
  const accountsByUser = new Map();
  const entries = [];
  for (const r of reservations) {
    const accounts = await ensureUserAccounts(tx, r.userId, r.currency ?? 'NGN');
    accountsByUser.set(r.userId, accounts);
    entries.push({ accountId: accounts.PLAYER_LOCKED.id, amountMinorUnits: -r.amountMinorUnits });
  }
  const winnerAccounts = accountsByUser.get(winnerId);
  if (!winnerAccounts) {
    throw new Error('Settlement winner must be part of the match reservations');
  }
  entries.push({ accountId: winnerAccounts.PLAYER_AVAILABLE.id, amountMinorUnits: netPayoutMinorUnits });
  const revenue = await ensureSystemAccount(tx, 'PLATFORM_REVENUE', 'NGN');
  entries.push({ accountId: revenue.id, amountMinorUnits: commissionMinorUnits });

  return postLedgerTransaction(tx, {
    type: 'MATCH_SETTLED_WIN',
    description: `Match ${matchId} settled: winner payout + platform commission`,
    idempotencyKey: `MATCH_SETTLEMENT:${matchId}`,
    relatedMatchId: matchId,
    metadata: { matchId, players: reservations.map((r) => r.userId), winnerId },
    entries
  });
}

/**
 * Posts the draw settlement (stakes returned to both players):
 *   PLAYER_LOCKED     -amount   (each player)
 *   PLAYER_AVAILABLE  +amount   (each player)
 * Net zero. Shares the same `MATCH_SETTLEMENT:{matchId}` idempotency key as a
 * win — no match can settle twice, so at most one of the two ever posts.
 */
export async function postSettlementDraw(tx, matchId, { reservations }) {
  const entries = [];
  for (const r of reservations) {
    const accounts = await ensureUserAccounts(tx, r.userId, r.currency ?? 'NGN');
    entries.push(
      { accountId: accounts.PLAYER_LOCKED.id, amountMinorUnits: -r.amountMinorUnits },
      { accountId: accounts.PLAYER_AVAILABLE.id, amountMinorUnits: r.amountMinorUnits }
    );
  }
  return postLedgerTransaction(tx, {
    type: 'MATCH_SETTLED_DRAW',
    description: `Match ${matchId} settled: stakes returned on draw`,
    idempotencyKey: `MATCH_SETTLEMENT:${matchId}`,
    relatedMatchId: matchId,
    metadata: { matchId, players: reservations.map((r) => r.userId) },
    entries
  });
}

/**
 * Posts the deposit credit for a webhook-confirmed deposit inside the caller's
 * transaction:
 *   CUSTOMER_LIABILITY   -amount   (external funds enter the player float)
 *   PLAYER_AVAILABLE     +amount   (player's spendable balance)
 * Net zero. Idempotent per deposit reference via `deposit:credit:{reference}`,
 * so a replayed or concurrent webhook delivery can never double-post. This is
 * the V2 mirror of the legacy Wallet increment; the legacy Wallet stays the
 * read source until the final read-flip milestone.
 */
export async function postDepositCredit(
  tx,
  { userId, amountMinorUnits, currency = 'NGN', depositIntentId, reference }
) {
  const amount = assertAmount(amountMinorUnits);
  const accounts = await ensureUserAccounts(tx, userId, currency);
  const liability = await ensureSystemAccount(tx, 'CUSTOMER_LIABILITY', currency);
  return postLedgerTransaction(tx, {
    type: 'DEPOSIT_CONFIRMED',
    description: `Deposit ${reference} credited to player`,
    idempotencyKey: `deposit:credit:${reference}`,
    metadata: { depositIntentId, reference },
    entries: [
      { accountId: liability.id, amountMinorUnits: -amount },
      { accountId: accounts.PLAYER_AVAILABLE.id, amountMinorUnits: amount }
    ]
  });
}

/**
 * Reserves funds for a withdrawal request inside the caller's transaction:
 *   PLAYER_AVAILABLE            -amount
 *   PLAYER_WITHDRAWAL_PENDING   +amount
 * Net zero. Idempotent per withdrawal via `withdrawal:reserve:{withdrawalId}`,
 * so a replayed or concurrent identical request can never reserve twice. This
 * is the V2 mirror of the legacy Wallet decrement written by the request flow.
 */
export async function postWithdrawalReserve(
  tx,
  { withdrawalId, userId, amountMinorUnits, currency = 'NGN' }
) {
  const amount = assertAmount(amountMinorUnits);
  const accounts = await ensureUserAccounts(tx, userId, currency);
  return postLedgerTransaction(tx, {
    type: 'WITHDRAWAL_PENDING',
    description: `Withdrawal ${withdrawalId} funds reserved for payout`,
    idempotencyKey: `withdrawal:reserve:${withdrawalId}`,
    metadata: { withdrawalId },
    entries: [
      { accountId: accounts.PLAYER_AVAILABLE.id, amountMinorUnits: -amount },
      { accountId: accounts.PLAYER_WITHDRAWAL_PENDING.id, amountMinorUnits: amount }
    ]
  });
}

/**
 * Posts the terminal completion of a withdrawal — the payout left the platform:
 *   PLAYER_WITHDRAWAL_PENDING   -amount
 *   CUSTOMER_LIABILITY          +amount   (returns toward zero; mirrors the
 *                                         deposit's writedown of liability)
 * Net zero. Idempotent per withdrawal via `withdrawal:complete:{withdrawalId}`.
 * The wallet was already debited at reserve time, so no mirror is needed here.
 */
export async function postWithdrawalComplete(
  tx,
  { withdrawalId, userId, amountMinorUnits, currency = 'NGN' }
) {
  const amount = assertAmount(amountMinorUnits);
  const accounts = await ensureUserAccounts(tx, userId, currency);
  const liability = await ensureSystemAccount(tx, 'CUSTOMER_LIABILITY', currency);
  return postLedgerTransaction(tx, {
    type: 'WITHDRAWAL_CONFIRMED',
    description: `Withdrawal ${withdrawalId} paid out and left the platform`,
    idempotencyKey: `withdrawal:complete:${withdrawalId}`,
    metadata: { withdrawalId },
    entries: [
      { accountId: accounts.PLAYER_WITHDRAWAL_PENDING.id, amountMinorUnits: -amount },
      { accountId: liability.id, amountMinorUnits: amount }
    ]
  });
}

/**
 * Releases a withdrawal that will never be paid (admin rejection or provider
 * failure) back into the player's available balance:
 *   PLAYER_WITHDRAWAL_PENDING   -amount
 *   PLAYER_AVAILABLE            +amount
 * Net zero. Idempotent per withdrawal via `withdrawal:release:{withdrawalId}`,
 * so a rejected payout can never return pending funds twice. This is the V2
 * mirror of the legacy Wallet refund written by the release flow.
 */
export async function postWithdrawalRelease(
  tx,
  { withdrawalId, userId, amountMinorUnits, currency = 'NGN' }
) {
  const amount = assertAmount(amountMinorUnits);
  const accounts = await ensureUserAccounts(tx, userId, currency);
  return postLedgerTransaction(tx, {
    type: 'WITHDRAWAL_RELEASED',
    description: `Withdrawal ${withdrawalId} released back to player`,
    idempotencyKey: `withdrawal:release:${withdrawalId}`,
    metadata: { withdrawalId },
    entries: [
      { accountId: accounts.PLAYER_WITHDRAWAL_PENDING.id, amountMinorUnits: -amount },
      { accountId: accounts.PLAYER_AVAILABLE.id, amountMinorUnits: amount }
    ]
  });
}

/**
 * Sanctioned admin money correction (the only sanctioned money-in/out without
 * a deposit/withdrawal/game event):
 *   CREDIT  CUSTOMER_LIABILITY -amount | PLAYER_AVAILABLE +amount  (money in)
 *   DEBIT   PLAYER_AVAILABLE   -amount | CUSTOMER_LIABILITY +amount  (money out)
 * Balanced, idempotent per reference, and a DEBIT never overdraws spendable
 * balance. Attributed to the acting admin in metadata.actorId, with a matching
 * admin-audit + wallet.updated outbox row in the same transaction.
 */
export async function postAdjustment(
  tx,
  {
    userId,
    amountMinorUnits,
    direction,
    reason,
    reference,
    actorId = null,
    currency = 'NGN'
  }
) {
  if (direction !== 'CREDIT' && direction !== 'DEBIT') {
    throw new InvalidAmountError('Adjustment direction must be CREDIT or DEBIT');
  }
  const amount = assertAmount(amountMinorUnits);
  const accounts = await ensureUserAccounts(tx, userId, currency);
  const liability = await ensureSystemAccount(tx, 'CUSTOMER_LIABILITY', currency);

  if (direction === 'DEBIT') {
    const available = await getLedgerAvailable(tx, userId, currency);
    if (available < amount) {
      throw new InsufficientFundsError();
    }
  }

  const entries =
    direction === 'CREDIT'
      ? [
          { accountId: liability.id, amountMinorUnits: -amount },
          { accountId: accounts.PLAYER_AVAILABLE.id, amountMinorUnits: amount }
        ]
      : [
          { accountId: accounts.PLAYER_AVAILABLE.id, amountMinorUnits: -amount },
          { accountId: liability.id, amountMinorUnits: amount }
        ];

  return postLedgerTransaction(tx, {
    type: direction === 'CREDIT' ? 'ADJUSTMENT_CREDIT' : 'ADJUSTMENT_DEBIT',
    description: `Admin ${direction.toLowerCase()} adjustment for ${userId}: ${reason ?? reference}`,
    idempotencyKey: `adjustment:${reference}`,
    metadata: { userId, direction, reason, actorId, reference },
    entries
  });
}

/**
 * Net balance of one account: sum of all signed entries.
 */
export async function getAccountBalance(client, accountId) {
  const agg = await client.ledgerEntry.aggregate({
    where: { accountId },
    _sum: { amountMinorUnits: true }
  });
  return agg._sum.amountMinorUnits ?? 0n;
}

/**
 * Read-only projection of a user's spendable balance (PLAYER_AVAILABLE net).
 * Unlike `getUserLedgerProjections` this NEVER creates accounts — a user with
 * no ledger history reads as zero. Safe for GET paths and for affordability
 * gates running under a wallet row lock (a read must not write).
 */
export async function getLedgerAvailable(client, userId, currency = 'NGN') {
  const accounts = await client.ledgerAccount.findMany({
    where: { userId, type: 'PLAYER_AVAILABLE', currency },
    select: { id: true }
  });
  if (accounts.length === 0) return 0n;
  const agg = await client.ledgerEntry.aggregate({
    where: { accountId: { in: accounts.map((a) => a.id) } },
    _sum: { amountMinorUnits: true }
  });
  return agg._sum.amountMinorUnits ?? 0n;
}

// Maps a user's PLAYER_AVAILABLE ledger entry (with its parent transaction) to
// the legacy WalletTransaction payload shape the Flutter app renders. Only the
// PLAYER_AVAILABLE leg of a posting is user-facing — locked/pending/internal
// legs never appear in the wallet feed (they never had mirror rows either).
// Both legacy members and their contract replacements are listed so the feed
// stays correct for pre- and post-remap rows.
const TX_TYPE = {
  DEPOSIT_CREDIT: { type: 'DEPOSIT', status: 'COMPLETED' },
  DEPOSIT_CONFIRMED: { type: 'DEPOSIT', status: 'COMPLETED' },
  STAKE_LOCK: { type: 'STAKE', status: 'COMPLETED' },
  STAKE_RESERVED: { type: 'STAKE', status: 'COMPLETED' },
  STAKE_RELEASE: { type: 'REFUND', status: 'COMPLETED' },
  STAKE_RELEASED: { type: 'REFUND', status: 'COMPLETED' },
  WITHDRAWAL_RESERVE: { type: 'WITHDRAWAL', status: 'PENDING' },
  WITHDRAWAL_PENDING: { type: 'WITHDRAWAL', status: 'PENDING' },
  WITHDRAWAL_RELEASE: { type: 'REFUND', status: 'COMPLETED' },
  WITHDRAWAL_RELEASED: { type: 'REFUND', status: 'COMPLETED' }
};

// Internal-only types that never produce a user-facing feed row: opening
// backfills and adjustment bookkeeping have no PLAYER_AVAILABLE leg that maps
// to a legacy mirror row, and payout-final moves money between internal
// accounts only. Legacy + contract members both listed for pre/post-remap rows.
const LEGACY_EXCLUDED_LEDGER_TYPES = new Set([
  'ADJUSTMENT',
  'ADJUSTMENT_CREDIT',
  'ADJUSTMENT_DEBIT',
  'WITHDRAWAL_COMPLETE',
  'WITHDRAWAL_CONFIRMED'
]);

function toWalletTransactionPayload(entry) {
  if (LEGACY_EXCLUDED_LEDGER_TYPES.has(entry.transaction.type)) return null;
  if (entry.transaction.type === 'SETTLEMENT_PAYOUT'
    || entry.transaction.type === 'MATCH_SETTLED_WIN'
    || entry.transaction.type === 'MATCH_SETTLED_DRAW') {
    // A decided match credits only the winner's available (PAYOUT); a draw
    // credits both players' available (REFUND). The winnerId in metadata
    // distinguishes them — same as the old mirror's PAYOUT vs REFUND rows.
    return {
      id: entry.id,
      type: entry.transaction.metadata?.winnerId ? 'PAYOUT' : 'REFUND',
      amountMinorUnits: entry.amountMinorUnits.toString(),
      status: 'COMPLETED',
      createdAt: entry.createdAt,
      relatedMatchId: entry.transaction.relatedMatchId ?? null
    };
  }
  const mapped = TX_TYPE[entry.transaction.type];
  if (!mapped) return null;
  return {
    id: entry.id,
    type: mapped.type,
    amountMinorUnits: entry.amountMinorUnits.toString(),
    status: mapped.status,
    createdAt: entry.createdAt,
    relatedMatchId: entry.transaction.relatedMatchId ?? null
  };
}

/**
 * Paginated projection of a user's wallet-feed transactions straight from the
 * ledger (PLAYER_AVAILABLE entries). Replaces the legacy WalletTransaction read
 * with the exact payload fields the Flutter app consumes
 * (id, type, amountMinorUnits, status, createdAt, relatedMatchId). Sign and
 * status match the legacy mirror convention (DEPOSIT +, STAKE -, PAYOUT +,
 * REFUND +, WITHDRAWAL - PENDING). No accounts are created.
 */
export async function getLedgerTransactions(
  client,
  userId,
  { page = 1, limit = 20, currency = 'NGN' } = {}
) {
  const accounts = await client.ledgerAccount.findMany({
    where: { userId, type: 'PLAYER_AVAILABLE', currency },
    select: { id: true }
  });
  if (accounts.length === 0) {
    return { transactions: [], total: 0, page, totalPages: 0 };
  }

  const where = {
    accountId: { in: accounts.map((a) => a.id) },
    // ADJUSTMENT and WITHDRAWAL_COMPLETE legs are internal: opening backfills
    // and payout-drain have no user-facing feed row (the legacy mirror never
    // wrote them either). Filtered at the query so `total` matches the feed.
    transaction: { type: { notIn: [...LEGACY_EXCLUDED_LEDGER_TYPES] } }
  };
  const skip = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    client.ledgerEntry.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: { transaction: true }
    }),
    client.ledgerEntry.count({ where })
  ]);

  return {
    transactions: rows.map(toWalletTransactionPayload).filter(Boolean),
    total,
    page,
    totalPages: Math.ceil(total / limit)
  };
}

/**
 * V2 projections for a user: available / locked / pending. Each is the net of
 * its account. All balances are returned as decimal strings (BigInt-exact).
 */
export async function getUserLedgerProjections(client, userId, currency = 'NGN') {
  const accounts = await ensureUserAccounts(client, userId, currency);
  const [available, locked, pending] = await Promise.all([
    getAccountBalance(client, accounts.PLAYER_AVAILABLE.id),
    getAccountBalance(client, accounts.PLAYER_LOCKED.id),
    getAccountBalance(client, accounts.PLAYER_WITHDRAWAL_PENDING.id)
  ]);
  return {
    available: available.toString(),
    locked: locked.toString(),
    pending: pending.toString()
  };
}