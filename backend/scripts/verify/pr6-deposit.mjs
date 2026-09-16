// Deep verification for PR 6 (Deposit V2 close-out: ledger mirror + outbox +
// notification + reconciliation).
//
// Exercises the real modules and the real Postgres + Redis dev stack, then
// asserts the financial invariants directly with SQL-level sums. Run from
// backend/ against a reachable dev DB + Redis:
//
//   DATABASE_URL=postgresql://draughts_arena:change_me_draughts_arena@127.0.0.1:5432/draughts_arena?schema=public \
//   REDIS_URL=redis://:change_me_draughts_redis@127.0.0.1:6379 \
//   node --env-file=.env scripts/verify/pr6-deposit.mjs
//
// All probe rows are cleaned up at the end (V2 ledger rows must go before the
// user because LedgerEntry.account is onDelete Restrict; the system
// CUSTOMER_LIABILITY singleton survives, like the other system accounts).
//
// Invariants checked:
//   P1  the stored intent is the only amount source (equality credits once)
//   P2  ledger mirror: DEPOSIT_CREDIT balanced, idempotent per reference,
//       PLAYER_AVAILABLE == legacy wallet, CUSTOMER_LIABILITY == -amount
//   P3  durable wallet.updated outbox row + DEPOSIT_CONFIRMED notification,
//       atomic with the credit
//   P4  concurrent double delivery: exactly one credit everywhere
//   P5  replay duplicate: acknowledged, zero new rows
//   P6  every rejection writes nothing (wallet/ledger/outbox/notification)
//   P7  a webhook claiming a different amount is rejected (never the source)
//   P8  reconciliation: stale PENDING -> FAILED; a LATE valid webhook still
//       credits exactly once; sweep healthy afterwards
//   P9  integrity: a COMPLETED intent whose ledger posting vanished is flagged
//       and NEVER auto-repaired
//   P10 closed-book: every ledger transaction zero-sums; PLAYER_AVAILABLE
//       reconciles to the legacy wallet; nothing lost or double-booked

import assert from 'node:assert/strict';
import prisma from '../../src/utils/db.js';
import {
  createDepositIntent,
  processDepositWebhook
} from '../../src/modules/wallet/service.js';
import { reconcileDeposits } from '../../src/jobs/depositReconciliation.js';
import {
  SYSTEM_ACCOUNT_ID,
  getAccountBalance
} from '../../src/services/ledgerService.js';

const WEBHOOK = (ref, amount, userId, gateway = 'PAYSTACK', currency = 'NGN') =>
  ({ reference: ref, amountMinorUnits: amount, currency, gateway, userId });

const state = { users: [] };
const results = [];

const ok = (name, detail = '') => results.push({ name, pass: true, detail });
const fail = (name, detail) => results.push({ name, pass: false, detail });

async function makeUser(suffix) {
  const user = await prisma.user.create({
    data: {
      email: `verify-pr6-${Date.now()}-${Math.random().toString(36).slice(2)}-${suffix}@test.local`,
      passwordHash: 'x',
      kycStatus: 'VERIFIED',
      countryCode: 'NG',
      eligibility: {
        create: { countryCode: 'NG', countryAllowed: true, ageVerified: true }
      }
    }
  });
  const wallet = await prisma.wallet.create({
    data: { userId: user.id, balanceMinorUnits: 0n }
  });
  state.users.push(user.id);
  return { user, wallet };
}

async function run(name, probe) {
  try {
    await probe();
  } catch (e) {
    fail(name, `${e?.constructor?.name}: ${e?.message}`);
    if (process.env.VERIFY_DEBUG === '1') console.error(e.stack);
  }
}

const ledgerCreditKey = (reference) => `deposit:credit:${reference}`;

async function ledgerCreditCount(reference) {
  return prisma.ledgerTransaction.count({
    where: { idempotencyKey: ledgerCreditKey(reference) }
  });
}

async function userBalance(wallet) {
  const current = await prisma.wallet.findUnique({ where: { id: wallet.id } });
  return current.balanceMinorUnits;
}

async function ledgerAvailable(userId) {
  const a = await prisma.ledgerAccount.findUnique({
    where: { userId_type_currency: { userId, type: 'PLAYER_AVAILABLE', currency: 'NGN' } }
  });
  return a ? getAccountBalance(prisma, a.id) : null;
}

async function liabilityBalance() {
  const a = await prisma.ledgerAccount.findUnique({
    where: { id: SYSTEM_ACCOUNT_ID('CUSTOMER_LIABILITY', 'NGN') }
  });
  return a ? getAccountBalance(prisma, a.id) : null;
}

async function outboxFor(walletId) {
  return prisma.outboxEvent.count({
    where: { aggregateId: walletId, eventType: 'wallet.updated' }
  });
}

async function noticesFor(userId) {
  return prisma.notification.count({ where: { userId, type: 'DEPOSIT_CONFIRMED' } });
}

// ---------------------------------------------------------------------------

await run('P1 stored intent is the only amount source', async () => {
  const { user, wallet } = await makeUser('a');
  const intent = await createDepositIntent(user.id, 50_000n, 'PAYSTACK', 'u@test.local');
  const res = await processDepositWebhook(WEBHOOK(intent.reference, 50_000, user.id));

  assert.equal(res.handled, true);
  assert.equal(res.alreadyApplied, false);
  assert.equal(await userBalance(wallet), 50_000n);
  const stored = await prisma.depositIntent.findUnique({ where: { id: intent.id } });
  assert.equal(stored.status, 'COMPLETED');
  assert.ok(stored.appliedAt);

  ok('P1 stored intent is the only amount source');
});

await run('P2 ledger mirror balances and matches the wallet', async () => {
  const { user, wallet } = await makeUser('a');
  const intent = await createDepositIntent(user.id, 50_000n, 'PAYSTACK', 'u@test.local');
  // CUSTOMER_LIABILITY is a persistent system singleton: assert the delta.
  const preLiability = (await liabilityBalance()) ?? 0n;
  await processDepositWebhook(WEBHOOK(intent.reference, 50_000, user.id));

  assert.equal(await ledgerCreditCount(intent.reference), 1);
  const ltx = await prisma.ledgerTransaction.findUnique({
    where: { idempotencyKey: ledgerCreditKey(intent.reference) },
    include: { entries: true }
  });
  assert.equal(ltx.type, 'DEPOSIT_CREDIT');
  assert.equal(ltx.entries.reduce((acc, e) => acc + e.amountMinorUnits, 0n), 0n);
  assert.equal(ltx.entries.length, 2);
  const liabilityId = SYSTEM_ACCOUNT_ID('CUSTOMER_LIABILITY', 'NGN');
  const entryByAccount = Object.fromEntries(
    ltx.entries.map((e) => [e.accountId, e.amountMinorUnits])
  );
  assert.equal(entryByAccount[liabilityId], -50_000n);
  // PLAYER_AVAILABLE == legacy wallet (the read source), and the liability
  // offset mirrors the float exactly.
  assert.equal(await ledgerAvailable(user.id), await userBalance(wallet));
  assert.equal(await ledgerAvailable(user.id), 50_000n);
  assert.equal((await liabilityBalance()) - preLiability, -50_000n);

  ok('P2 ledger mirror balances and matches the wallet');
});

await run('P3 durable outbox + notification, atomic with the credit', async () => {
  const { user, wallet } = await makeUser('a');
  const intent = await createDepositIntent(user.id, 25_000n, 'FLUTTERWAVE', 'u@test.local');
  await processDepositWebhook(WEBHOOK(intent.reference, 25_000, user.id, 'FLUTTERWAVE'));

  assert.equal(await outboxFor(wallet.id), 1);
  const outbox = await prisma.outboxEvent.findFirst({
    where: { aggregateId: wallet.id, eventType: 'wallet.updated' }
  });
  assert.equal(outbox.aggregateType, 'Wallet');
  assert.equal(outbox.payload.amountMinorUnits, '25000');
  assert.equal(await noticesFor(user.id), 1);
  const notice = await prisma.notification.findFirst({
    where: { userId: user.id, type: 'DEPOSIT_CONFIRMED' }
  });
  assert.match(notice.message, /250\.00/);

  // A replay produces no second outbox row or notification.
  await processDepositWebhook(WEBHOOK(intent.reference, 25_000, user.id, 'FLUTTERWAVE'));
  assert.equal(await outboxFor(wallet.id), 1);
  assert.equal(await noticesFor(user.id), 1);

  ok('P3 durable outbox + notification, atomic with the credit');
});

await run('P4 concurrent double delivery credits once everywhere', async () => {
  const { user, wallet } = await makeUser('a');
  const intent = await createDepositIntent(user.id, 50_000n, 'PAYSTACK', 'u@test.local');
  const webhook = WEBHOOK(intent.reference, 50_000, user.id);

  const resultsArr = await Promise.all([
    processDepositWebhook(webhook),
    processDepositWebhook(webhook)
  ]);

  const applied = resultsArr.filter((r) => r.handled && !r.alreadyApplied);
  const dupes = resultsArr.filter((r) => r.alreadyApplied);
  assert.equal(applied.length, 1);
  assert.equal(dupes.length, 1);
  assert.equal(await userBalance(wallet), 50_000n);
  assert.equal(await ledgerCreditCount(intent.reference), 1);
  assert.equal(await outboxFor(wallet.id), 1);
  assert.equal(await noticesFor(user.id), 1);

  ok('P4 concurrent double delivery credits once everywhere');
});

await run('P5 replay duplicate acknowledged, zero new rows', async () => {
  const { user, wallet } = await makeUser('a');
  const intent = await createDepositIntent(user.id, 50_000n, 'PAYSTACK', 'u@test.local');
  const webhook = WEBHOOK(intent.reference, 50_000, user.id);

  const first = await processDepositWebhook(webhook);
  const second = await processDepositWebhook(webhook);
  assert.equal(first.handled, true);
  assert.equal(second.handled, false);
  assert.equal(second.alreadyApplied, true);

  assert.equal(await userBalance(wallet), 50_000n);
  assert.equal(await ledgerCreditCount(intent.reference), 1);
  assert.equal(await outboxFor(wallet.id), 1);
  assert.equal(await noticesFor(user.id), 1);

  ok('P5 replay duplicate acknowledged, zero new rows');
});

await run('P6 every rejection writes nothing', async () => {
  const { user, wallet } = await makeUser('a');
  const intent = await createDepositIntent(user.id, 50_000n, 'PAYSTACK', 'u@test.local');

  const rejects = [
    WEBHOOK(intent.reference, 99_999, user.id),            // amount
    WEBHOOK(intent.reference, 50_000, 'some-other-user'),  // user
    WEBHOOK(intent.reference, 50_000, user.id, 'PAYSTACK', 'USD'), // currency
    WEBHOOK(intent.reference, 50_000, user.id, 'FLUTTERWAVE'),     // gateway
    WEBHOOK('never-created-ref', 50_000, user.id)          // unknown reference
  ];

  for (const webhook of rejects) {
    const res = await processDepositWebhook(webhook);
    assert.equal(res.handled, false);
  }

  assert.equal(await userBalance(wallet), 0n);
  assert.equal(await ledgerCreditCount(intent.reference), 0);
  assert.equal(await ledgerAvailable(user.id), null);
  assert.equal(await outboxFor(wallet.id), 0);
  assert.equal(await noticesFor(user.id), 0);
  const stored = await prisma.depositIntent.findUnique({ where: { id: intent.id } });
  assert.equal(stored.status, 'PENDING');

  ok('P6 every rejection writes nothing');
});

await run('P7 webhook amount is never the source of truth', async () => {
  const { user, wallet } = await makeUser('a');
  const intent = await createDepositIntent(user.id, 50_000n, 'PAYSTACK', 'u@test.local');
  // Claimed 50001 for a 50000 intent: rejected even though it is "close".
  const res = await processDepositWebhook(WEBHOOK(intent.reference, 50_001, user.id));
  assert.equal(res.handled, false);
  assert.equal(res.reason, 'AMOUNT_MISMATCH');
  assert.equal(await userBalance(wallet), 0n);
  assert.equal(await ledgerCreditCount(intent.reference), 0);

  ok('P7 webhook amount is never the source of truth');
});

await run('P8 reconciliation parks stale intents and a late webhook still credits once', async () => {
  const { user, wallet } = await makeUser('a');
  const intent = await createDepositIntent(user.id, 50_000n, 'PAYSTACK', 'u@test.local');
  // Backdate past the 24h stale threshold.
  await prisma.depositIntent.update({
    where: { id: intent.id },
    data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }
  });

  const parked = await reconcileDeposits();
  assert.ok(parked.staleParked >= 1);
  let stored = await prisma.depositIntent.findUnique({ where: { id: intent.id } });
  assert.equal(stored.status, 'FAILED');
  assert.equal(await userBalance(wallet), 0n);

  // Late-but-valid provider webhook: still credits exactly once.
  const late = await processDepositWebhook(WEBHOOK(intent.reference, 50_000, user.id));
  assert.equal(late.handled, true);
  stored = await prisma.depositIntent.findUnique({ where: { id: intent.id } });
  assert.equal(stored.status, 'COMPLETED');
  assert.equal(await userBalance(wallet), 50_000n);
  assert.equal(await ledgerCreditCount(intent.reference), 1);
  assert.equal(await outboxFor(wallet.id), 1);
  assert.equal(await noticesFor(user.id), 1);

  const after = await reconcileDeposits();
  assert.deepEqual(after.anomalies, []);

  ok('P8 reconciliation parks stale intents and a late webhook still credits once');
});

await run('P9 integrity flags a vanished ledger posting and never repairs', async () => {
  const { user, wallet } = await makeUser('a');
  const intent = await createDepositIntent(user.id, 50_000n, 'PAYSTACK', 'u@test.local');
  await processDepositWebhook(WEBHOOK(intent.reference, 50_000, user.id));
  assert.equal(await ledgerCreditCount(intent.reference), 1);

  // Simulate the anomaly: the ledger posting disappears (entries cascade).
  await prisma.ledgerTransaction.deleteMany({
    where: { idempotencyKey: ledgerCreditKey(intent.reference) }
  });

  const summary = await reconcileDeposits();
  assert.equal(
    summary.anomalies.some((a) => a.check === 'ledgerPostingMissing'),
    true
  );
  assert.equal(await ledgerCreditCount(intent.reference), 0);
  assert.equal(await userBalance(wallet), 50_000n);

  ok('P9 integrity flags a vanished ledger posting and never repairs');
});

await run('P10 closed book: zero-sum ledger, wallet reconciles, nothing lost', async () => {
  const { user, wallet } = await makeUser('a');
  const preLiability = (await liabilityBalance()) ?? 0n;
  // Two deposits through two gateways.
  const i1 = await createDepositIntent(user.id, 40_000n, 'PAYSTACK', 'u@test.local');
  const i2 = await createDepositIntent(user.id, 60_000n, 'FLUTTERWAVE', 'u@test.local');
  await processDepositWebhook(WEBHOOK(i1.reference, 40_000, user.id));
  await processDepositWebhook(WEBHOOK(i2.reference, 60_000, user.id, 'FLUTTERWAVE'));

  // Every DEPOSIT_CREDIT for this user is individually balanced.
  const txs = await prisma.ledgerTransaction.findMany({
    where: {
      OR: [
        { idempotencyKey: ledgerCreditKey(i1.reference) },
        { idempotencyKey: ledgerCreditKey(i2.reference) }
      ]
    },
    include: { entries: true }
  });
  assert.equal(txs.length, 2);
  for (const t of txs) {
    assert.equal(t.entries.reduce((acc, e) => acc + e.amountMinorUnits, 0n), 0n);
  }

  // Global zero-sum: sum of ALL ledger entries across every account is 0.
  const allEntries = await prisma.ledgerEntry.aggregate({
    _sum: { amountMinorUnits: true }
  });
  assert.equal(allEntries._sum.amountMinorUnits ?? 0n, 0n);

  // Player float reconciles to the legacy wallet.
  assert.equal(await userBalance(wallet), 100_000n);
  assert.equal(await ledgerAvailable(user.id), 100_000n);
  assert.equal((await liabilityBalance()) - preLiability, -100_000n);
  assert.equal(await outboxFor(wallet.id), 2);
  assert.equal(await noticesFor(user.id), 2);

  ok('P10 closed book: zero-sum ledger, wallet reconciles, nothing lost');
});

// ---------------------------------------------------------------------------

console.log(`\n${'='.repeat(64)}`);
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `  [${r.detail}]`}`);
}
console.log('='.repeat(64));
const failed = results.filter((r) => !r.pass).length;
console.log(`${results.length - failed}/${results.length} probes passed\n`);

// Cleanup: deposit-scoped wallet/outbox/notification/ledger rows before users.
try {
  for (const userId of state.users) {
    const intents = await prisma.depositIntent.findMany({
      where: { userId },
      select: { id: true }
    });
    for (const intent of intents) {
      await prisma.ledgerEntry.deleteMany({
        where: { transaction: { metadata: { path: ['depositIntentId'], equals: intent.id } } }
      });
      await prisma.ledgerTransaction.deleteMany({
        where: { metadata: { path: ['depositIntentId'], equals: intent.id } }
      });
    }
    const wallets = await prisma.wallet.findMany({ where: { userId } });
    for (const wallet of wallets) {
      await prisma.walletTransaction.deleteMany({ where: { walletId: wallet.id } });
      await prisma.outboxEvent.deleteMany({ where: { aggregateId: wallet.id } });
    }
    await prisma.notification.deleteMany({ where: { userId } });
    await prisma.depositIntent.deleteMany({ where: { userId } });
    await prisma.wallet.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }
  console.log('cleanup: all probe rows removed');
} catch (e) {
  console.error('cleanup failed (manual review needed):', e.message);
  process.exitCode = 2;
}

await prisma.$disconnect();
process.exitCode = failed > 0 ? 1 : process.exitCode;