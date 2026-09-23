// Deep verification for PR 12 (durable outbox + provider payout follow-up +
// financial reconciliation close-out). Exercises the real modules against the
// real Postgres + Redis dev stack, then asserts the financial invariants with
// SQL-level sums. Run from backend/ against a reachable dev DB + Redis:
//
//   DATABASE_URL=postgresql://draughts_arena:change_me_draughts_arena@127.0.0.1:5432/draughts_arena?schema=public \
//   REDIS_URL=redis://:change_me_draughts_redis@127.0.0.1:6379 \
//   node --env-file=.env scripts/verify/pr12-outbox-reconciliation.mjs
//
// The outbox probes count claimed/delivered/backoff/failed events per drain, so
// the DB must be probe-controlled: run against a freshly wiped dev DB (the
// exit gate does exactly this), or flush the main dev rows first.
//
// All probe rows are cleaned up at the end (ledger postings by idempotency key
// before the domain rows; the system CUSTOMER_LIABILITY singleton survives).
//
// Invariants checked:
//   O1  a PENDING outbox event is claimed, delivered and settled SENT once
//   O2  a dedupeKey replay enqueues nothing new (check-first idempotency)
//   O3  a live lease is left alone; an expired lease is reclaimed & delivered
//   O4  a failing delivery backs off (attempts++, lease cleared) then delivers
//   O5  a persistently failing delivery parks the event FAILED at max attempts
//   O6  an unknown eventType is parked FAILED as a hard product bug
//   O7  concurrent same-dedupeKey enqueues: exactly one row, losers resolve a
//       silent no-op (the P2002 race fallback), replay after is a clean no-op
//   W1  a stale PROCESSING payout resolves to COMPLETED from a provider success
//       verdict, exactly once, with WITHDRAWAL_COMPLETE + durable notification
//   W2  a provider failure verdict marks FAILED and never moves money
//   W3  an ambiguous verdict records the check and re-probes later
//   R1  a healthy book closes: every transaction zero-sums, closed book holds,
//       liability is a singleton and the sweep reports zero discrepancies
//   R2  a tampered posting is flagged (ledger+closed book) and never repaired
//
// After cleanup the whole-DB book is re-checked: zero-sum ledger, single
// liability account and a green reconciliation sweep.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import prisma from '../../src/utils/db.js';
import { WithdrawalService } from '../../src/modules/withdrawal/service.js';
import { createDepositIntent, processDepositWebhook } from '../../src/modules/wallet/service.js';
import { enqueueEvent, enqueueWalletUpdated } from '../../src/services/outboxService.js';
import { processOutboxDrainer } from '../../src/jobs/outboxDrainer.js';
import { processProviderFollowUp } from '../../src/jobs/providerFollowUp.js';
import { runFinancialReconciliation } from '../../src/jobs/financialReconciliation.js';
import { SYSTEM_ACCOUNT_ID, getAccountBalance } from '../../src/services/ledgerService.js';

const results = [];
const ok = (name, detail = '') => results.push({ name, pass: true, detail });
const fail = (name, detail) => results.push({ name, pass: false, detail });

const state = { users: [], outboxAggregateIds: new Set(), runIds: [] };

// Each outbox probe leaves its rows behind; a later drain would then pick up
// stray PENDING rows from earlier probes and corrupt the delivered/backoff/
// failed counts. Remove every row a probe created before moving on.
const cleanupOutboxIds = (...ids) =>
  prisma.outboxEvent.deleteMany({ where: { id: { in: ids } } });

async function run(name, probe) {
  try {
    await probe();
  } catch (e) {
    fail(name, `${e?.constructor?.name}: ${e?.message}`);
    if (process.env.VERIFY_DEBUG === '1') console.error(e.stack);
  }
}

const uuid = () => crypto.randomUUID();

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

// ---------------------------------------------------------------------------
// Outbox probes: enqueue through the real service (inside a real tx, exactly
// like the writers) and drain with a delivery recorder so the socket push can
// stay out of the harness (it is covered by the integration battery).
// ---------------------------------------------------------------------------

const recorderDeliver = (record) => async (event) => {
  if (event.eventType === 'wallet.updated') {
    record.push(event);
    return;
  }
  if (event.eventType === 'notification') {
    record.push(event);
    return;
  }
  throw new Error(`outbox drainer cannot deliver unknown eventType: ${event.eventType}`);
};

async function drainRecorder() {
  const delivered = [];
  const result = await processOutboxDrainer({ deliver: recorderDeliver(delivered) });
  return { result, delivered };
}

await run('O1 PENDING outbox event is claimed, delivered and settled SENT once', async () => {
  const aggregateId = uuid();
  state.outboxAggregateIds.add(aggregateId);
  const key = `verify:o1:${uuid()}`;
  await prisma.$transaction((tx) =>
    enqueueWalletUpdated(tx, {
      userId: uuid(),
      walletId: aggregateId,
      currency: 'NGN',
      type: 'MATCH_SETTLEMENT',
      amountMinorUnits: 25_000n,
      dedupeKey: key
    })
  );

  const { result, delivered } = await drainRecorder();
  assert.equal(result.delivered, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].aggregateType, 'Wallet');
  const row = await prisma.outboxEvent.findUnique({ where: { dedupeKey: key } });
  assert.equal(row.status, 'SENT');
  assert.equal(row.claimToken, null);

  // second drain has nothing left
  const again = await drainRecorder();
  assert.equal(again.result.scanned, 0);
  assert.equal(again.delivered.length, 0);

  await cleanupOutboxIds(row.id);
  ok('O1 PENDING outbox event is claimed, delivered and settled SENT once');
});

await run('O2 dedupeKey replay enqueues nothing new', async () => {
  const aggregateId = uuid();
  state.outboxAggregateIds.add(aggregateId);
  const key = `verify:o2:${uuid()}`;

  const first = await prisma.$transaction((tx) =>
    enqueueEvent(tx, {
      aggregateType: 'Wallet',
      aggregateId,
      eventType: 'wallet.updated',
      dedupeKey: key,
      payload: { userId: uuid(), walletId: aggregateId, balanceChange: '100' }
    })
  );
  assert.ok(first?.id);

  const replay = await prisma.$transaction((tx) =>
    enqueueEvent(tx, {
      aggregateType: 'Wallet',
      aggregateId: uuid(),
      eventType: 'wallet.updated',
      dedupeKey: key,
      payload: {}
    })
  );
  assert.equal(replay, null);
  assert.equal(await prisma.outboxEvent.count({ where: { dedupeKey: key } }), 1);

  await cleanupOutboxIds(first.id);
  ok('O2 dedupeKey replay enqueues nothing new');
});

await run('O3 live lease is left alone, expired lease is reclaimed and delivered', async () => {
  const aggregateId = uuid();
  state.outboxAggregateIds.add(aggregateId);
  const now = Date.now();
  const live = await prisma.outboxEvent.create({
    data: {
      aggregateType: 'Wallet',
      aggregateId,
      eventType: 'wallet.updated',
      payload: { userId: uuid(), walletId: aggregateId, balanceChange: '50' },
      claimToken: 'alive-lease',
      claimExpiresAt: new Date(now + 60_000)
    }
  });
  const expired = await prisma.outboxEvent.create({
    data: {
      aggregateType: 'Wallet',
      aggregateId,
      eventType: 'wallet.updated',
      payload: { userId: uuid(), walletId: aggregateId, balanceChange: '50' },
      claimToken: null,
      claimExpiresAt: new Date(now - 60_000)
    }
  });

  const { result, delivered } = await drainRecorder();
  // the live-lease row is skipped entirely; the expired one is reclaimed
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].id, expired.id);
  assert.equal((await prisma.outboxEvent.findUnique({ where: { id: live.id } })).status, 'PENDING');
  assert.equal((await prisma.outboxEvent.findUnique({ where: { id: expired.id } })).status, 'SENT');
  assert.ok(result.claimed >= 1);

  await cleanupOutboxIds(live.id, expired.id);
  ok('O3 live lease is left alone, expired lease is reclaimed and delivered');
});

await run('O4 failing delivery backs off with attempts++ and still delivers later', async () => {
  const aggregateId = uuid();
  state.outboxAggregateIds.add(aggregateId);
  const key = `verify:o4:${uuid()}`;
  await prisma.$transaction((tx) =>
    enqueueEvent(tx, {
      aggregateType: 'Wallet',
      aggregateId,
      eventType: 'wallet.updated',
      dedupeKey: key,
      payload: { userId: uuid(), walletId: aggregateId, balanceChange: '10' }
    })
  );

  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls === 1) throw new Error('transient socket loss');
  };
  const first = await processOutboxDrainer({ deliver: flaky });
  assert.equal(first.delivered, 0);
  assert.equal(first.backoff, 1);
  let row = await prisma.outboxEvent.findUnique({ where: { dedupeKey: key } });
  assert.equal(row.status, 'PENDING'); // lease cleared, never parked
  assert.equal(row.attempts, 1);
  assert.equal(row.claimToken, null);

  const { result, delivered } = await drainRecorder();
  assert.equal(result.delivered, 1);
  assert.equal(delivered.length, 1);
  row = await prisma.outboxEvent.findUnique({ where: { dedupeKey: key } });
  assert.equal(row.status, 'SENT');
  assert.equal(row.attempts, 1); // successful settle leaves attempts untouched

  await cleanupOutboxIds(row.id);
  ok('O4 failing delivery backs off with attempts++ and still delivers later');
});

await run('O5 persistently failing delivery parks the event FAILED at max attempts', async () => {
  const aggregateId = uuid();
  state.outboxAggregateIds.add(aggregateId);
  const key = `verify:o5:${uuid()}`;
  await prisma.$transaction((tx) =>
    enqueueEvent(tx, {
      aggregateType: 'Wallet',
      aggregateId,
      eventType: 'wallet.updated',
      dedupeKey: key,
      payload: { userId: uuid(), walletId: aggregateId, balanceChange: '10' }
    })
  );

  const broken = async () => {
    throw new Error('provider offline');
  };
  const result = await processOutboxDrainer({ deliver: broken, maxAttempts: 1 });
  assert.equal(result.failed, 1);
  const row = await prisma.outboxEvent.findUnique({ where: { dedupeKey: key } });
  assert.equal(row.status, 'FAILED');
  assert.equal(row.attempts, 1);
  assert.match(row.lastError, /provider offline/);

  // parked rows are never re-seen by the drainer
  const again = await processOutboxDrainer({ deliver: broken, maxAttempts: 1 });
  assert.equal(again.scanned, 0);

  await cleanupOutboxIds(row.id);
  ok('O5 persistently failing delivery parks the event FAILED at max attempts');
});

await run('O6 unknown eventType is parked FAILED as a hard product bug', async () => {
  const aggregateId = uuid();
  state.outboxAggregateIds.add(aggregateId);
  const key = `verify:o6:${uuid()}`;
  await prisma.$transaction((tx) =>
    enqueueEvent(tx, {
      aggregateType: 'Whatever',
      aggregateId,
      eventType: 'not.implemented',
      dedupeKey: key,
      payload: {}
    })
  );
  // real default deliver path: throws on unknown eventType, parked on the first
// attempt (maxAttempts 1) so the probe is not deferred by the backoff policy
  const delivered = [];
  const result = await processOutboxDrainer({
    deliver: recorderDeliver(delivered),
    maxAttempts: 1
  });
  assert.equal(delivered.length, 0);
  assert.equal(result.failed, 1);
  const row = await prisma.outboxEvent.findUnique({ where: { dedupeKey: key } });
  assert.equal(row.status, 'FAILED');

  await cleanupOutboxIds(row.id);
  ok('O6 unknown eventType is parked FAILED as a hard product bug');
});

await run('O7 concurrent same-dedupeKey enqueue: one row, losers reject, replay no-op', async () => {
  const aggregateId = uuid();
  state.outboxAggregateIds.add(aggregateId);
  const key = `verify:o7:${uuid()}`;

  // Raw writers racing the unique dedupeKey: the unique index admits exactly
  // one row. The losing inserts hit P2002 which enqueueEvent swallows (race
  // fallback) and, being the last statement in the tx, the transaction
  // silently commits-as-rollback — so every loser RESOLVES null, nothing
  // corrupts, no request 500s. Real writers never even reach this: their
  // upstream CAS / row locks serialize identical deliveries first.
  const attempt = () =>
    prisma.$transaction((tx) =>
      enqueueEvent(tx, {
        aggregateType: 'Wallet',
        aggregateId,
        eventType: 'wallet.updated',
        dedupeKey: key,
        payload: { userId: uuid(), walletId: aggregateId, balanceChange: '10' }
      })
    );
  const settled = await Promise.allSettled(Array.from({ length: 8 }, attempt));
  const winners = settled.filter((s) => s.status === 'fulfilled' && s.value?.id);
  const losers = settled.filter((s) => s.status === 'rejected');
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 0);
  assert.equal(await prisma.outboxEvent.count({ where: { dedupeKey: key } }), 1);

  // After the race the check-first path returns null (a clean replay no-op).
  const replay = await prisma.$transaction((tx) =>
    enqueueEvent(tx, {
      aggregateType: 'Wallet',
      aggregateId: uuid(),
      eventType: 'wallet.updated',
      dedupeKey: key,
      payload: {}
    })
  );
  assert.equal(replay, null);

  const row = await prisma.outboxEvent.findUnique({ where: { dedupeKey: key } });
  await cleanupOutboxIds(row.id);
  ok('O7 concurrent same-dedupeKey enqueue: one row, losers resolve no-op');
});

// ---------------------------------------------------------------------------
// Provider payout follow-up probes: real funding -> real reserve -> stuck at
// the provider -> the sweep resolves it from the (stubbed) provider verdict.
// ---------------------------------------------------------------------------

const makeUser = async () => {
  const user = await prisma.user.create({
    data: {
      email: `verify-pr12-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`,
      passwordHash: 'x',
      kycStatus: 'VERIFIED',
      countryCode: 'NG',
      eligibility: {
        create: { countryCode: 'NG', countryAllowed: true, ageVerified: true }
      }
    }
  });
  const wallet = await prisma.wallet.create({ data: { userId: user.id } });
  const bankAccount = await prisma.bankAccount.create({
    data: {
      userId: user.id,
      gateway: 'PAYSTACK',
      bankCode: '057',
      bankName: 'Zenith',
      accountNumber: '0123456789',
      accountName: 'Jane Doe',
      verifiedName: 'Jane Doe',
      recipientRef: 'RCP-fake',
      verifiedAt: new Date()
    }
  });
  state.users.push(user.id);
  state.outboxAggregateIds.add(wallet.id);
  return { user, wallet, bankAccount };
};

const fund = async (userId, amountMinorUnits) => {
  const intent = await createDepositIntent(userId, amountMinorUnits, 'PAYSTACK');
  await processDepositWebhook({
    reference: intent.reference,
    amountMinorUnits,
    currency: 'NGN',
    gateway: 'PAYSTACK',
    userId
  });
  return intent;
};

const fakeProvider = (verifyStatus) => ({
  resolveBankAccount: async () => ({ accountName: 'Jane Doe' }),
  createRecipient: async () => ({ recipientRef: 'RCP-fake' }),
  initiatePayout: async () => ({ providerRef: `prov-${uuid()}` }),
  verifyPayoutStatus: verifyStatus
});

const makeService = (verifyStatus) =>
  new WithdrawalService({ providers: { PAYSTACK: fakeProvider(verifyStatus) } });

const toProcessing = async (service, fixture, amountMinorUnits) => {
  const requested = await service.requestWithdrawal(
    fixture.user.id,
    amountMinorUnits,
    undefined,
    fixture.bankAccount.id
  );
  await service.approveWithdrawal(requested.id, 'admin-1');
  return service.beginPayout(requested.id);
};

const agePastThreshold = async (withdrawalId) =>
  prisma.withdrawal.updateMany({
    where: { id: withdrawalId },
    data: { processedAt: new Date(Date.now() - 7 * 60 * 60 * 1000) }
  });

await run('W1 stale payout resolves COMPLETED on a provider success verdict, exactly once', async () => {
  const fixture = await makeUser();
  await fund(fixture.user.id, 200_000n);
  const service = makeService(async () => ({ status: 'success' }));
  const { id } = await toProcessing(service, fixture, 100_000n);
  await agePastThreshold(id);

  const result = await processProviderFollowUp({ service, ageHours: 6 });
  assert.equal(result.scanned, 1);
  assert.equal(result.resolved, 1);

  const row = await prisma.withdrawal.findUnique({ where: { id } });
  assert.equal(row.status, 'COMPLETED');
  assert.equal(row.failureReason, null);

  const complete = await prisma.ledgerTransaction.findUnique({
    where: { idempotencyKey: `withdrawal:complete:${id}` },
    include: { entries: true }
  });
  assert.ok(complete);
  assert.equal(complete.entries.reduce((acc, e) => acc + e.amountMinorUnits, 0n), 0n);

  // durable WITHDRAWAL_CONFIRMED notification + its outbox delivery
  const notice = await prisma.notification.findFirst({
    where: { userId: fixture.user.id, type: 'WITHDRAWAL_CONFIRMED' }
  });
  assert.ok(notice?.id);
  assert.match(notice.message, /has been paid out/);
  state.outboxAggregateIds.add(notice.id);
  const outbox = await prisma.outboxEvent.findUnique({
    where: { dedupeKey: `notify:withdrawal:${id}` }
  });
  assert.ok(outbox);
  assert.equal(outbox.eventType, 'notification');

  // the sweep resolves it once: a second probe finds nothing to do
  const again = await processProviderFollowUp({ service, ageHours: 1 });
  assert.equal(again.scanned, 0);
  assert.equal(
    await prisma.ledgerTransaction.count({ where: { idempotencyKey: `withdrawal:complete:${id}` } }),
    1
  );

  ok('W1 stale payout resolves COMPLETED on a provider success verdict, exactly once');
});

await run('W2 provider failure verdict parks FAILED and never moves money', async () => {
  const fixture = await makeUser();
  await fund(fixture.user.id, 200_000n);
  const service = makeService(async () => ({ status: 'failed' }));
  const { id } = await toProcessing(service, fixture, 100_000n);
  await agePastThreshold(id);

  const result = await processProviderFollowUp({ service, ageHours: 6 });
  assert.equal(result.resolved, 1);
  const row = await prisma.withdrawal.findUnique({ where: { id } });
  assert.equal(row.status, 'FAILED');
  assert.match(row.failureReason, /follow-up sweep/i);

  // no terminal posting; the reserved funds stay put until the operator decides
  assert.equal(
    await prisma.ledgerTransaction.count({
      where: { idempotencyKey: { in: [`withdrawal:complete:${id}`, `withdrawal:release:${id}`] } }
    }),
    0
  );

  ok('W2 provider failure verdict parks FAILED and never moves money');
});

await run('W3 ambiguous verdict records the check and re-probes later', async () => {
  const fixture = await makeUser();
  await fund(fixture.user.id, 200_000n);
  const service = makeService(async () => ({ status: 'processing' }));
  const { id } = await toProcessing(service, fixture, 100_000n);
  await agePastThreshold(id);

  const first = await processProviderFollowUp({ service, ageHours: 6 });
  assert.equal(first.pending, 1);
  assert.equal(first.resolved, 0);

  let row = await prisma.withdrawal.findUnique({ where: { id } });
  assert.equal(row.status, 'PROCESSING');
  assert.ok(row.followUpCheckAt);

  // the just-recorded check suppresses an immediate re-probe (30m recheck)
  const second = await processProviderFollowUp({ service, ageHours: 6 });
  assert.equal(second.scanned, 0);

  // a later run (past the recheck window) probes again but still no money moves
  await prisma.withdrawal.updateMany({
    where: { id },
    data: { followUpCheckAt: new Date(Date.now() - 40 * 60 * 1000) }
  });
  const third = await processProviderFollowUp({ service, ageHours: 6 });
  assert.equal(third.pending, 1);
  row = await prisma.withdrawal.findUnique({ where: { id } });
  assert.equal(row.status, 'PROCESSING');

  ok('W3 ambiguous verdict records the check and re-probes later');
});

// ---------------------------------------------------------------------------
// Financial reconciliation probes (read-only sweep; NEVER repairs).
// ---------------------------------------------------------------------------

await run('R1 healthy book closes with zero discrepancies', async () => {
  const fixture = await makeUser();
  await fund(fixture.user.id, 300_000n);
  const service = makeService(async () => ({ status: 'success' }));
  await toProcessing(service, fixture, 120_000n);

  // funds both a completed withdrawal and a fresh deposit credit in flight
  const sweep = await runFinancialReconciliation();
  state.runIds.push(sweep.runId);

  assert.equal(sweep.status, 'PASSED');
  assert.deepEqual(sweep.discrepancies, []);
  const allChecks = sweep.checks.map((c) => c.name);
  assert.ok(allChecks.includes('ledger.closed_book'));
  assert.ok(allChecks.includes('ledger.liability_singleton'));

  const agg = await prisma.ledgerEntry.aggregate({ _sum: { amountMinorUnits: true } });
  assert.equal(agg._sum.amountMinorUnits ?? 0n, 0n);

  ok('R1 healthy book closes with zero discrepancies');
});

await run('R2 a tampered posting is flagged and never repaired', async () => {
  const fixture = await makeUser();
  const intent = await fund(fixture.user.id, 100_000n);

  const credit = await prisma.ledgerTransaction.findUnique({
    where: { idempotencyKey: `deposit:credit:${intent.reference}` },
    include: { entries: true }
  });
  const availEntry = credit.entries.find((e) => e.amountMinorUnits === 100_000n);
  const original = availEntry.amountMinorUnits;
  // a rogue poster changed PLAYER_AVAILABLE after the fact
  await prisma.ledgerEntry.update({
    where: { id: availEntry.id },
    data: { amountMinorUnits: original + 5_000n }
  });

  const sweep = await runFinancialReconciliation();
  state.runIds.push(sweep.runId);
  assert.equal(sweep.status, 'FAILED');
  const names = sweep.checks.filter((c) => !c.ok).map((c) => c.name);
  assert.ok(names.some((n) => n.startsWith('deposit.') && n.includes('credit.amount')));
  assert.ok(names.includes('ledger.closed_book'));

  // never repaired: the wrong amount is exactly what the sweep reported
  const after = await prisma.ledgerEntry.findUnique({ where: { id: availEntry.id } });
  assert.equal(after.amountMinorUnits, original + 5_000n);

  // restore so cleanup + the final book-close both pass
  await prisma.ledgerEntry.update({
    where: { id: availEntry.id },
    data: { amountMinorUnits: original }
  });
  const healed = await runFinancialReconciliation();
  state.runIds.push(healed.runId);
  assert.equal(healed.status, 'PASSED');

  ok('R2 a tampered posting is flagged and never repaired');
});

// ---------------------------------------------------------------------------

console.log(`\n${'='.repeat(64)}`);
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `  [${r.detail}]`}`);
}
console.log('='.repeat(64));
const failed = results.filter((r) => !r.pass).length;
console.log(`${results.length - failed}/${results.length} probes passed\n`);

// Cleanup: unwind every ledger posting and durable row before the users go.
let finalExit = 0;
try {
  for (const userId of state.users) {
    const withdrawalIds = (await prisma.withdrawal.findMany({ where: { userId }, select: { id: true } })).map((w) => w.id);
    const depositRefs = (await prisma.depositIntent.findMany({ where: { userId }, select: { reference: true } })).map((d) => d.reference);
    const keys = [];
    for (const id of withdrawalIds) {
      keys.push(`withdrawal:complete:${id}`, `withdrawal:reserve:${id}`, `withdrawal:release:${id}`);
    }
    for (const ref of depositRefs) keys.push(`deposit:credit:${ref}`);
    await prisma.ledgerTransaction.deleteMany({ where: { idempotencyKey: { in: keys } } });

    const noticeIds = (await prisma.notification.findMany({ where: { userId }, select: { id: true } })).map((n) => n.id);
    for (const id of noticeIds) state.outboxAggregateIds.add(id);
    await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: [...state.outboxAggregateIds] } } });
    await prisma.notification.deleteMany({ where: { userId } });
    await prisma.withdrawal.deleteMany({ where: { userId } });
    await prisma.depositIntent.deleteMany({ where: { userId } });
    await prisma.bankAccount.deleteMany({ where: { userId } });
    await prisma.wallet.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }
  await prisma.financialReconciliationRun.deleteMany({ where: { id: { in: state.runIds } } });
  console.log('cleanup: all probe rows removed');
} catch (e) {
  console.error('cleanup failed (manual review needed):', e.message);
  finalExit = 2;
}

// Whole-DB book close after cleanup: zero-sum, single liability, green sweep.
try {
  const txs = await prisma.ledgerTransaction.findMany({ include: { entries: true } });
  const unbalanced = txs.filter(
    (t) => t.entries.reduce((acc, e) => acc + e.amountMinorUnits, 0n) !== 0n
  );
  const agg = await prisma.ledgerEntry.aggregate({ _sum: { amountMinorUnits: true } });
  const liabilityCount = await prisma.ledgerAccount.count({ where: { type: 'CUSTOMER_LIABILITY' } });
  const sweep = await runFinancialReconciliation();

  const clean =
    unbalanced.length === 0 &&
    (agg._sum.amountMinorUnits ?? 0n) === 0n &&
    liabilityCount === 1 &&
    (sweep?.discrepancies?.length ?? 0) === 0;

  if (clean) {
    console.log('PASS  post-cleanup whole-DB book: zero-sum, singleton intact, sweep silent');
  } else {
    console.log(
      `FAIL  post-cleanup whole-DB book ` +
      `[unbalanced=${unbalanced.length} globalSum=${String(agg._sum.amountMinorUnits ?? 0n)} ` +
      `liabilityAccounts=${liabilityCount} discrepancies=${JSON.stringify(sweep?.discrepancies)}]`
    );
    finalExit = 1;
  }
} catch (e) {
  console.error('book-close check failed:', e.message);
  finalExit = 1;
}

await prisma.$disconnect();
process.exit(failed > 0 || finalExit !== 0 ? 1 : 0);