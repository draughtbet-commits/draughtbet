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

const LEDGER_ENTRY_TYPES = new Set([
  'DEPOSIT_CREDIT',
  'STAKE_LOCK',
  'STAKE_RELEASE',
  'SETTLEMENT_PAYOUT',
  'WITHDRAWAL_RESERVE',
  'WITHDRAWAL_COMPLETE',
  'WITHDRAWAL_RELEASE',
  'ADJUSTMENT'
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

const assertAmount = (amount) => {
  if (typeof amount !== 'bigint' || amount === 0n) {
    throw new InvalidAmountError();
  }
  return amount;
};

/**
 * Resolves (create-if-missing) a single ledger account for a user.
 * The compound unique [userId, type, currency] makes concurrent creation safe.
 */
export async function getOrCreateUserAccount(tx, userId, type, currency = 'NGN') {
  if (!PLAYER_ACCOUNT_TYPES.includes(type)) {
    throw new Error(`Cannot create ${type} as a user account`);
  }
  return await tx.ledgerAccount.upsert({
    where: { userId_type_currency: { userId, type, currency } },
    create: { userId, type, currency },
    update: {}
  });
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
 * enforce uniqueness by itself.
 */
export async function ensureSystemAccount(tx, type, currency = 'NGN') {
  if (!SYSTEM_ACCOUNT_TYPES.includes(type)) {
    throw new Error(`Cannot create ${type} as a system account`);
  }
  const id = SYSTEM_ACCOUNT_ID(type, currency);
  return await tx.ledgerAccount.upsert({
    where: { id },
    create: { id, type, currency, userId: null },
    update: {}
  });
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
 * read-source bridge until the final read-flip PR.
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
    type: 'STAKE_LOCK',
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
    type: 'STAKE_RELEASE',
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
    type: 'SETTLEMENT_PAYOUT',
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
    type: 'SETTLEMENT_PAYOUT',
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
 * read source until the final read-flip PR.
 */
export async function postDepositCredit(
  tx,
  { userId, amountMinorUnits, currency = 'NGN', depositIntentId, reference }
) {
  const amount = assertAmount(amountMinorUnits);
  const accounts = await ensureUserAccounts(tx, userId, currency);
  const liability = await ensureSystemAccount(tx, 'CUSTOMER_LIABILITY', currency);
  return postLedgerTransaction(tx, {
    type: 'DEPOSIT_CREDIT',
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

/**
 * Backfills one legacy wallet into the V2 ledger with an opening transaction:
 *   SYSTEM_OPENING_CLEARING  -amountMinorUnits
 *   PLAYER_AVAILABLE         +amountMinorUnits
 *
 * Idempotent per wallet (idempotencyKey = `opening-balance:{walletId}`), so a
 * re-run never double-credits. Zero-balance wallets skip the posting (nothing
 * to carry) but still get their accounts created.
 */
export async function backfillWalletOpeningBalance(wallet) {
  const currency = wallet.currency ?? 'NGN';
  const amount = BigInt(wallet.balanceMinorUnits);
  if (amount < 0n) throw new InvalidAmountError('Cannot backfill a negative wallet');

  return await prisma.$transaction(async (tx) => {
    const playerAccounts = await ensureUserAccounts(tx, wallet.userId, currency);
    if (amount === 0n) {
      return {
        walletId: wallet.id,
        posted: false,
        reason: 'zero-balance'
      };
    }

    const clearing = await ensureSystemAccount(tx, 'SYSTEM_OPENING_CLEARING', currency);
    const { transaction, entries, replayed } = await postLedgerTransaction(tx, {
      type: 'ADJUSTMENT',
      description: 'Opening balance carried over from legacy wallet',
      idempotencyKey: `opening-balance:${wallet.id}`,
      metadata: { walletId: wallet.id, source: 'legacy-wallet-backfill' },
      entries: [
        { accountId: clearing.id, amountMinorUnits: -amount },
        { accountId: playerAccounts.PLAYER_AVAILABLE.id, amountMinorUnits: amount }
      ]
    });

    logger.info(
      { walletId: wallet.id, amount: amount.toString(), replayed },
      'Wallet opening balance backfilled into ledger'
    );

    return {
      walletId: wallet.id,
      posted: true,
      replayed,
      transactionId: transaction.id,
      entries: entries.length
    };
  });
}

/**
 * Compares a legacy wallet's balance to its ledger PROJECTED available.
 * Also reports locked/pending so a partially-wired PR never hides a mismatch.
 */
export async function reconcileWalletToLedger(client, wallet) {
  const projections = await getUserLedgerProjections(client, wallet.userId, wallet.currency ?? 'NGN');
  const expected = BigInt(wallet.balanceMinorUnits).toString();
  return {
    walletId: wallet.id,
    userId: wallet.userId,
    balanceMinorUnits: expected,
    available: projections.available,
    locked: projections.locked,
    pending: projections.pending,
    reconciled: expected === projections.available
  };
}

/**
 * Backfills every legacy wallet and reconciles each one. Returns the summary;
 * the exit gate for PR 2 is `summary.allReconciled === true`.
 */
export async function backfillAndReconcileAllWallets() {
  const wallets = await prisma.wallet.findMany();
  const results = [];

  for (const wallet of wallets) {
    const backfilled = await backfillWalletOpeningBalance(wallet);
    results.push({
      ...(await reconcileWalletToLedger(prisma, wallet)),
      transactionId: backfilled.posted ? backfilled.transactionId : null
    });
  }

  const reconciled = results.filter((r) => r.reconciled).length;
  return {
    total: results.length,
    reconciled,
    mismatched: results.length - reconciled,
    allReconciled: results.length > 0 && reconciled === results.length,
    results
  };
}