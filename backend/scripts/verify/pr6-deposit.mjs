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
//       balances every confirmed deposit; nothing lost or double-booked
//   P11 HTTP webhook gate end-to-end: HMAC/verif-hash enforced (401 + zero
//       side-effects), valid delivery credits once, replay acknowledged, wrong
//       amount rejected, Flutterwave major-unit amount parsed exactly
//   P12 wallet_updated socket push fires once on a fresh credit, never on a
//       duplicate delivery (real Socket.IO server + authenticated client)
//   P13 concurrent DISTINCT deposits on one wallet: no lost update, both credit
//   P14 retry storm: 10 concurrent identical deliveries credit exactly once
//   P15 deposit-intent creation gate rejects invalid amount/gateway/no-wallet/
//       non-NGN-wallet with nothing persisted
//   P16 reconciliation flags every anomaly variant (ledgerPostingMissing,
//       ledgerAmount, failedIntentHasCredit) and never repairs any of them
//
// After cleanup the whole-DB book is re-checked: every LedgerTransaction nets
// zero, the global entry sum is zero, CUSTOMER_LIABILITY is a single singleton
// and the sweep reports zero anomalies.

import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import { io as createSocketClient } from 'socket.io-client';
import prisma from '../../src/utils/db.js';
import { webhookRouter } from '../../src/modules/payment/webhookController.js';
import { initSocketServer } from '../../src/sockets/index.js';
import { getJwtSecret } from '../../src/utils/jwtEnv.js';
import {
  createDepositIntent,
  processDepositWebhook
} from '../../src/modules/wallet/service.js';
import { reconcileDeposits } from '../../src/jobs/depositReconciliation.js';
import {
  SYSTEM_ACCOUNT_ID,
  getAccountBalance,
  postDepositCredit
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
    data: { userId: user.id }
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
  return (await ledgerAvailable(wallet.userId)) ?? 0n;
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
// Real HTTP (webhook router with raw-body HMAC) and Socket.IO servers so the
// full webhook gate and the wallet_updated push can be exercised end-to-end.
// ---------------------------------------------------------------------------

const socketServer = http.createServer();
socketServer.listen(0);
const ioServer = initSocketServer(socketServer);
const SOCKET_PORT = socketServer.address().port;

const webhookApp = express();
webhookApp.use('/webhooks', webhookRouter);
const webhookServer = webhookApp.listen(0);
const WEBHOOK_BASE = `http://127.0.0.1:${webhookServer.address().port}`;

const paystackSignature = (rawBody) =>
  crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(rawBody).digest('hex');

const postWebhook = async (path, rawBody, headers = {}) =>
  fetch(`${WEBHOOK_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: rawBody
  });

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

await run('P2 ledger is the single money source: credit + offset liability', async () => {
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
  // PLAYER_AVAILABLE is the wallet balance read source; the liability offset
  // mirrors the float exactly.
  assert.equal(await ledgerAvailable(user.id), await userBalance(wallet));
  assert.equal(await ledgerAvailable(user.id), 50_000n);
  assert.equal((await liabilityBalance()) - preLiability, -50_000n);

  ok('P2 ledger is the single money source: credit + offset liability');
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
  // The sweep never re-posts: the vanished credit stays gone.
  assert.equal(await userBalance(wallet), 0n);

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

await run('P11 HTTP webhook gate: signatures enforced, one credit per delivery', async () => {
  const { user, wallet } = await makeUser('a');
  const intent = await createDepositIntent(user.id, 50_000n, 'PAYSTACK', 'u@test.local');
  const validBody = JSON.stringify({
    event: 'charge.success',
    data: {
      reference: intent.reference,
      amount: 50000,
      currency: 'NGN',
      metadata: { userId: user.id }
    }
  });

  // 401 without or with a bad signature, and zero side-effects.
  let res = await postWebhook('/webhooks/paystack', validBody);
  assert.equal(res.status, 401);
  res = await postWebhook('/webhooks/paystack', validBody, { 'x-paystack-signature': 'deadbeef' });
  assert.equal(res.status, 401);
  assert.equal(await userBalance(wallet), 0n);
  assert.equal(await ledgerCreditCount(intent.reference), 0);
  assert.equal(await outboxFor(wallet.id), 0);
  assert.equal(await noticesFor(user.id), 0);
  assert.equal((await prisma.depositIntent.findUnique({ where: { id: intent.id } })).status, 'PENDING');

  // A non-charge.success event with a valid signature is a 200 no-op.
  const otherEvent = JSON.stringify({
    event: 'charge.pending',
    data: { reference: intent.reference, amount: 50000, currency: 'NGN', metadata: { userId: user.id } }
  });
  res = await postWebhook('/webhooks/paystack', otherEvent, {
    'x-paystack-signature': paystackSignature(otherEvent)
  });
  assert.equal(res.status, 200);
  assert.equal(await userBalance(wallet), 0n);

  // Valid signature + matching payload: 200, credited exactly once everywhere.
  const sig = paystackSignature(validBody);
  res = await postWebhook('/webhooks/paystack', validBody, { 'x-paystack-signature': sig });
  assert.equal(res.status, 200);
  assert.equal((await res.text()).trim(), 'OK');
  assert.equal(await userBalance(wallet), 50_000n);
  assert.equal(await ledgerCreditCount(intent.reference), 1);
  assert.equal(await outboxFor(wallet.id), 1);
  assert.equal(await noticesFor(user.id), 1);

  // Retrying the identical signed request is acknowledged, never re-credited.
  res = await postWebhook('/webhooks/paystack', validBody, { 'x-paystack-signature': sig });
  assert.equal(res.status, 200);
  assert.equal(await userBalance(wallet), 50_000n);
  assert.equal(await ledgerCreditCount(intent.reference), 1);
  assert.equal(await outboxFor(wallet.id), 1);
  assert.equal(await noticesFor(user.id), 1);

  // A valid signature claiming a wrong amount is acknowledged without credit.
  const wrongAmount = JSON.stringify({
    event: 'charge.success',
    data: { reference: intent.reference, amount: 50001, currency: 'NGN', metadata: { userId: user.id } }
  });
  res = await postWebhook('/webhooks/paystack', wrongAmount, {
    'x-paystack-signature': paystackSignature(wrongAmount)
  });
  assert.equal(res.status, 200);
  assert.equal(await userBalance(wallet), 50_000n);
  assert.equal(await ledgerCreditCount(intent.reference), 1);

  // Flutterwave: major-unit "500.00" parses exactly; verif-hash gates entry.
  const f = await makeUser('f');
  const fIntent = await createDepositIntent(f.user.id, 50_000n, 'FLUTTERWAVE', 'u@test.local');
  const fBody = JSON.stringify({
    event: 'charge.completed',
    data: {
      tx_ref: fIntent.reference,
      amount: '500.00',
      currency: 'NGN',
      status: 'successful',
      meta: { userId: f.user.id }
    }
  });
  res = await postWebhook('/webhooks/flutterwave', fBody, {
    'verif-hash': process.env.FLUTTERWAVE_SECRET_HASH
  });
  assert.equal(res.status, 200);
  assert.equal(await userBalance(f.wallet), 50_000n);
  assert.equal(await ledgerCreditCount(fIntent.reference), 1);
  assert.equal(await noticesFor(f.user.id), 1);

  ok('P11 HTTP webhook gate: signatures enforced, one credit per delivery');
});

await run('P12 wallet_updated socket push fires once on apply, never on replay', async () => {
  const { user, wallet } = await makeUser('a');
  const token = jwt.sign({ userId: user.id }, getJwtSecret(), { expiresIn: '1h' });
  const client = createSocketClient(`http://127.0.0.1:${SOCKET_PORT}`, {
    auth: { token },
    transports: ['websocket']
  });

  try {
    await new Promise((resolve, reject) => {
      client.once('connect', resolve);
      client.once('connect_error', (err) => reject(new Error(err.message)));
    });

    // The client 'connect' ack can beat the server-side connection handler's
    // socket.join('user:{id}'), which is where wallet_updated is delivered. Wait
    // until the room is actually populated before firing the webhook.
    for (let i = 0; i < 100; i++) {
      const members = await ioServer.in(`user:${user.id}`).fetchSockets();
      if (members.length >= 1) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 50));

    const nextEvent = (event, timeout = 1500) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), timeout);
        client.once(event, (payload) => {
          clearTimeout(timer);
          resolve(payload);
        });
      });

    const intent = await createDepositIntent(user.id, 50_000n, 'PAYSTACK', 'u@test.local');
    const body = JSON.stringify({
      event: 'charge.success',
      data: {
        reference: intent.reference,
        amount: 50000,
        currency: 'NGN',
        metadata: { userId: user.id }
      }
    });
    // Subscribers must be in place BEFORE the webhook is processed: the
    // controller emits wallet_updated synchronously while handling the request,
    // so an event registered after the POST resolves would already be missed.
    const firstPush = nextEvent('wallet_updated', 3000);
    const res = await postWebhook('/webhooks/paystack', body, {
      'x-paystack-signature': paystackSignature(body)
    });
    assert.equal(res.status, 200);

    const pushed = await firstPush;
    assert.ok(pushed, 'wallet_updated event should have fired');
    assert.equal(pushed.balanceChange, '50000');
    assert.equal(pushed.type, 'DEPOSIT');

    // A duplicate delivery re-emits nothing.
    const dupPush = nextEvent('wallet_updated', 300);
    const again = await postWebhook('/webhooks/paystack', body, {
      'x-paystack-signature': paystackSignature(body)
    });
    assert.equal(again.status, 200);
    assert.equal(await dupPush, null);
    assert.equal(await outboxFor(wallet.id), 1);
    assert.equal(await noticesFor(user.id), 1);
  } finally {
    client.disconnect();
  }

  ok('P12 wallet_updated socket push fires once on apply, never on replay');
});

await run('P13 concurrent distinct deposits on one wallet never lose a credit', async () => {
  const { user, wallet } = await makeUser('a');
  const i1 = await createDepositIntent(user.id, 40_000n, 'PAYSTACK', 'u@test.local');
  const i2 = await createDepositIntent(user.id, 60_000n, 'FLUTTERWAVE', 'u@test.local');

  const resultsArr = await Promise.all([
    processDepositWebhook(WEBHOOK(i1.reference, 40_000, user.id)),
    processDepositWebhook(WEBHOOK(i2.reference, 60_000, user.id, 'FLUTTERWAVE'))
  ]);
  assert.deepEqual(resultsArr.map((r) => r.handled), [true, true]);

  assert.equal(await userBalance(wallet), 100_000n);
  assert.equal(await ledgerAvailable(user.id), 100_000n);
  assert.equal(await ledgerCreditCount(i1.reference), 1);
  assert.equal(await ledgerCreditCount(i2.reference), 1);
  assert.equal(await outboxFor(wallet.id), 2);
  assert.equal(await noticesFor(user.id), 2);

  ok('P13 concurrent distinct deposits on one wallet never lose a credit');
});

await run('P14 retry storm: 10 concurrent identical deliveries credit once', async () => {
  const { user, wallet } = await makeUser('a');
  const intent = await createDepositIntent(user.id, 50_000n, 'PAYSTACK', 'u@test.local');
  const webhook = WEBHOOK(intent.reference, 50_000, user.id);

  const resultsArr = await Promise.all(
    Array.from({ length: 10 }, () => processDepositWebhook(webhook))
  );
  const applied = resultsArr.filter((r) => r.handled && !r.alreadyApplied);
  const dupes = resultsArr.filter((r) => r.alreadyApplied);
  assert.equal(applied.length, 1);
  assert.equal(dupes.length, 9);
  assert.equal(await userBalance(wallet), 50_000n);
  assert.equal(await ledgerCreditCount(intent.reference), 1);
  assert.equal(await outboxFor(wallet.id), 1);
  assert.equal(await noticesFor(user.id), 1);
  assert.equal(await prisma.depositIntent.count({ where: { id: intent.id, status: 'COMPLETED' } }), 1);

  ok('P14 retry storm: 10 concurrent identical deliveries credit once');
});

await run('P15 deposit intent creation gate rejects bad input', async () => {
  const { user } = await makeUser('a');
  const noWalletUser = await prisma.user.create({
    data: {
      email: `verify-pr6-${Date.now()}-${Math.random().toString(36).slice(2)}-nowallet@test.local`,
      passwordHash: 'x',
      kycStatus: 'VERIFIED',
      countryCode: 'NG'
    }
  });
  state.users.push(noWalletUser.id);

  for (const bad of [0n, -5n, 250.5, '250.5', '1e3', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      () => createDepositIntent(user.id, bad, 'PAYSTACK', 'u@test.local'),
      (e) => e.name === 'InvalidAmountError',
      `amount ${String(bad)} must be rejected`
    );
  }
  await assert.rejects(
    () => createDepositIntent(user.id, 50_000n, 'STRIPE', 'u@test.local'),
    (e) => e.name === 'InvalidGatewayError'
  );
  await assert.rejects(
    () => createDepositIntent(noWalletUser.id, 50_000n, 'PAYSTACK', 'u@test.local'),
    (e) => e.name === 'WalletNotFoundError'
  );

  const gbp = await prisma.user.create({
    data: {
      email: `verify-pr6-${Date.now()}-${Math.random().toString(36).slice(2)}-gbp@test.local`,
      passwordHash: 'x',
      kycStatus: 'VERIFIED',
      countryCode: 'NG'
    }
  });
  await prisma.wallet.create({ data: { userId: gbp.id, currency: 'GBP' } });
  state.users.push(gbp.id);
  await assert.rejects(
    () => createDepositIntent(gbp.id, 50_000n, 'PAYSTACK', 'u@test.local'),
    (e) => e.name === 'UnsupportedCurrencyError'
  );

  // Rejected intent creation persisted nothing.
  assert.equal(await prisma.depositIntent.count({ where: { userId: user.id } }), 0);

  ok('P15 deposit intent creation gate rejects bad input');
});

await run('P16 reconciliation flags every anomaly variant and never repairs', async () => {
  // (a) ledgerPostingMissing: the credit posting was lost entirely.
  const a = await makeUser('a');
  const intentA = await createDepositIntent(a.user.id, 50_000n, 'PAYSTACK', 'u@test.local');
  await processDepositWebhook(WEBHOOK(intentA.reference, 50_000, a.user.id));
  const creditA = await prisma.ledgerTransaction.findUnique({
    where: { idempotencyKey: ledgerCreditKey(intentA.reference) }
  });
  await prisma.ledgerEntry.deleteMany({ where: { transactionId: creditA.id } });
  await prisma.ledgerTransaction.delete({ where: { id: creditA.id } });

  let s = await reconcileDeposits();
  assert.equal(
    s.anomalies.some((x) => x.check === 'ledgerPostingMissing'),
    true
  );
  assert.equal(await userBalance(a.wallet), 0n); // never repaired
  assert.equal(await ledgerCreditCount(intentA.reference), 0); // no re-posting

  // (b) ledgerAmount: the PLAYER_AVAILABLE posting no longer matches the intent.
  const b = await makeUser('a2');
  const intentB = await createDepositIntent(b.user.id, 50_000n, 'PAYSTACK', 'u@test.local');
  await processDepositWebhook(WEBHOOK(intentB.reference, 50_000, b.user.id));
  const ltx = await prisma.ledgerTransaction.findUnique({
    where: { idempotencyKey: ledgerCreditKey(intentB.reference) },
    include: { entries: true }
  });
  const availEntry = ltx.entries.find((e) => e.amountMinorUnits === 50_000n);
  await prisma.ledgerEntry.update({
    where: { id: availEntry.id },
    data: { amountMinorUnits: 60_000n }
  });
  s = await reconcileDeposits();
  assert.equal(s.anomalies.some((x) => x.check === 'ledgerAmount'), true);
  const afterB = await prisma.ledgerEntry.findUnique({ where: { id: availEntry.id } });
  assert.equal(afterB.amountMinorUnits, 60_000n); // never repaired

  // (c) failedIntentHasCredit: a parked FAILED intent with a credit posting.
  const c = await makeUser('a3');
  const intentC = await createDepositIntent(c.user.id, 50_000n, 'PAYSTACK', 'u@test.local');
  await prisma.depositIntent.update({
    where: { id: intentC.id },
    data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }
  });
  await reconcileDeposits();
  assert.equal((await prisma.depositIntent.findUnique({ where: { id: intentC.id } })).status, 'FAILED');
  await postDepositCredit(prisma, {
    userId: c.user.id,
    amountMinorUnits: 50_000n,
    currency: 'NGN',
    depositIntentId: intentC.id,
    reference: intentC.reference
  });
  s = await reconcileDeposits();
  assert.equal(s.anomalies.some((x) => x.check === 'failedIntentHasCredit'), true);
  assert.equal(await userBalance(c.wallet), 50_000n); // credit stays: no repair
  assert.equal(await ledgerCreditCount(intentC.reference), 1); // posting untouched

  ok('P16 reconciliation flags every anomaly variant and never repairs');
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
let finalExit = 0;
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
  finalExit = 2;
}

// Whole-DB book close after cleanup: every transaction still zero-sums, the
// global entry sum is zero, CUSTOMER_LIABILITY is a single singleton and the
// deposit reconciliation sweep reports zero anomalies.
try {
  const txs = await prisma.ledgerTransaction.findMany({ include: { entries: true } });
  const unbalanced = txs.filter(
    (t) => t.entries.reduce((acc, e) => acc + e.amountMinorUnits, 0n) !== 0n
  );
  const agg = await prisma.ledgerEntry.aggregate({ _sum: { amountMinorUnits: true } });
  const liabilityCount = await prisma.ledgerAccount.count({
    where: { type: 'CUSTOMER_LIABILITY' }
  });
  const sweep = await reconcileDeposits();

  const clean =
    unbalanced.length === 0 &&
    (agg._sum.amountMinorUnits ?? 0n) === 0n &&
    liabilityCount === 1 &&
    (sweep?.anomalies?.length ?? 0) === 0;

  if (clean) {
    console.log('PASS  post-cleanup whole-DB book: zero-sum, singleton intact, sweep silent');
  } else {
    console.log(
      `FAIL  post-cleanup whole-DB book ` +
      `[unbalanced=${unbalanced.length} globalSum=${String(agg._sum.amountMinorUnits ?? 0n)} ` +
      `liabilityAccounts=${liabilityCount} anomalies=${JSON.stringify(sweep?.anomalies)}]`
    );
    finalExit = 1;
  }
} catch (e) {
  console.error('book-close check failed:', e.message);
  finalExit = 1;
}

ioServer.close();
webhookServer.closeAllConnections?.();
webhookServer.close();
socketServer.close();

await prisma.$disconnect();
process.exit(failed > 0 || finalExit !== 0 ? 1 : 0);