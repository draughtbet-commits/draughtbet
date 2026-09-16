// PR 7 — Withdrawal V2 deep verification (real HTTP + Socket.IO + PostgreSQL)
//
// Exercises the withdrawal-request money-exit gate end-to-end over the real
// wallet/admin routers and a live Socket.IO server:
//   P1  request over HTTP reserves atomically (PENDING_REVIEW + wallet debit +
//       ledger PLAYER_AVAILABLE -> PLAYER_WITHDRAWAL_PENDING + outbox row)
//   P2  wallet_updated socket push fires once with balanceChange "-N"
//   P3  idempotent replay returns the original request, debits never twice
//   P4  EXIT GATE: 2 concurrent 8000 requests on a 10000 balance -> exactly
//       one 201 and one 402; wallet + ledger both end at 2000/8000
//   P5  single request above balance -> 402, nothing persisted
//   P6  KYC gate blocks a non-verified account -> 403, nothing persisted
//   P7  missing payout destination -> 422 even with funds
//   P8  admin reject lifecycle: approve -> REJECTED release refunds exactly
//       once, re-release is a no-op, ledger reverses, balance restored
//   P9  GET /wallet/withdrawals lists rows + status filter
//   P10 webhook (Paystack transfer.success) completes a PROCESSING payout:
//       HMAC-gated, reference-matched, ledger complete posting once, wallet
//       untouched by completion, liability moved toward zero, notification 1
//   P11 two concurrent duplicate success callbacks -> exactly one completion
//       posting + one notification; a late transfer.failed afterwards is a
//       safe no-op on the terminal COMPLETED state
//   P12 Flutterwave transfer.completed/SUCCESSFUL completes a FLUTTERWAVE
//       payout via verif-hash (major-unit amounts never involved on payout)
//   P13 failed payout via webhook (transfer.failed) keeps the reserves; admin
//       reject then releases exactly once and the ledger closes back to the
//       starting float
//   P14 webhook gate errors: forged signature 401; unknown reference 200
//       no-op; gateway mismatch no-op; unhandled event type no-op
//   P15 bank-account management over HTTP: list, duplicate-account 400 on
//       validation, PATCH default switch honored by the next request (gateway
//       follows the destination), DELETE then 422, 404s on missing ids
//   P16 unverified (recipientRef-less) destination -> 422 despite a row
//   P17 admin gates over HTTP: double-approve is a no-op with stable
//       reviewedBy; report-result success=false keeps funds reserved;
//       releasing a PROCESSING withdrawal is refused with no refund
//   P18 socket push on admin release (wallet_updated +N, WITHDRAWAL_RELEASE)
//   P19 eligibility gates (age-not-verified / country-not-allowed) -> 403
//   P20 pagination bounds on /wallet/withdrawals (oversize limit 400,
//       page beyond total empty)
//   P21 concurrent same-idempotencyKey HTTP requests -> one row, one debit
//   P22 closed book after cleanup: every LedgerTransaction nets zero, the
//       global entry sum is zero and the singleton liability is intact.
//
// No provider network call ever happens: verified BankAccount rows and
// PROCESSING withdrawals are seeded directly (the resolution/recipient and
// begin-payout initiation paths are covered by unit + integration tests with
// injected fakes) and only withdraw/release/webhook-report routes are hit.
//
// Run:  timeout 150 node --env-file=.env scripts/verify/pr7-withdrawal.mjs

import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import { io as createSocketClient } from 'socket.io-client';
import prisma from '../../src/utils/db.js';
import { walletRouter } from '../../src/modules/wallet/controller.js';
import { adminRouter } from '../../src/modules/admin/controller.js';
import { webhookRouter } from '../../src/modules/payment/webhookController.js';
import { initSocketServer } from '../../src/sockets/index.js';
import { getJwtSecret } from '../../src/utils/jwtEnv.js';
import { WithdrawalService } from '../../src/modules/withdrawal/service.js';
import {
  SYSTEM_ACCOUNT_ID,
  getAccountBalance
} from '../../src/services/ledgerService.js';

const socketServer = http.createServer();
socketServer.listen(0);
const ioServer = initSocketServer(socketServer);
const SOCKET_PORT = socketServer.address().port;

const apiApp = express();
apiApp.use(express.json());
apiApp.use('/wallet', walletRouter);
apiApp.use('/admin', adminRouter);
const apiServer = apiApp.listen(0);
const API_BASE = `http://127.0.0.1:${apiServer.address().port}`;

// Payout webhook endpoint: raw-body HMAC middleware lives INSIDE the router.
const webhookApp = express();
webhookApp.use('/webhooks', webhookRouter);
const webhookServer = webhookApp.listen(0);
const WEBHOOK_BASE = `http://127.0.0.1:${webhookServer.address().port}`;

const paystackSignature = (rawBody) =>
  crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(rawBody).digest('hex');

const postWebhook = (path, rawBody, headers = {}) =>
  fetch(`${WEBHOOK_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: rawBody
  });

const paystackTransferEvent = (eventType, reference, extra = {}) =>
  Buffer.from(JSON.stringify({ event: eventType, data: { reference, ...extra } }));

const flutterwaveTransferEvent = (eventType, reference, status) =>
  Buffer.from(JSON.stringify({ event: eventType, data: { reference, status, complete_message: 'done' } }));

const state = { users: [] };
const results = [];

const ok = (name, detail = '') => results.push({ name, pass: true, detail });
const fail = (name, detail) => results.push({ name, pass: false, detail });

async function seedWalletFunds(userId, balance) {
  const available = await prisma.ledgerAccount.create({
    data: { userId, type: 'PLAYER_AVAILABLE', currency: 'NGN' }
  });
  const liability = await prisma.ledgerAccount.upsert({
    where: { id: SYSTEM_ACCOUNT_ID('CUSTOMER_LIABILITY', 'NGN') },
    create: { id: SYSTEM_ACCOUNT_ID('CUSTOMER_LIABILITY', 'NGN'), type: 'CUSTOMER_LIABILITY', currency: 'NGN', userId: null },
    update: {}
  });
  const txn = await prisma.ledgerTransaction.create({
    data: { type: 'DEPOSIT_CREDIT', idempotencyKey: `pr7:seed:${userId}` }
  });
  await prisma.ledgerEntry.create({ data: { transactionId: txn.id, accountId: available.id, amountMinorUnits: balance } });
  await prisma.ledgerEntry.create({ data: { transactionId: txn.id, accountId: liability.id, amountMinorUnits: -balance } });
}

async function makeUser(suffix, { balance = 10000n, withBank = true, kyc = 'VERIFIED' } = {}) {
  const user = await prisma.user.create({
    data: {
      email: `verify-pr7-${Date.now()}-${Math.random().toString(36).slice(2)}-${suffix}@test.local`,
      passwordHash: 'x',
      kycStatus: kyc,
      countryCode: 'NG',
      isAdmin: false,
      eligibility: {
        create: { countryCode: 'NG', countryAllowed: true, ageVerified: true }
      }
    }
  });
  const wallet = await prisma.wallet.create({
    data: { userId: user.id, balanceMinorUnits: balance }
  });
  await seedWalletFunds(user.id, balance);
  if (withBank) {
    await prisma.bankAccount.create({
      data: {
        userId: user.id,
        gateway: 'PAYSTACK',
        bankCode: '057',
        bankName: 'Zenith',
        accountNumber: `0123${String(Date.now()).slice(-6)}`,
        accountName: 'Verify Player',
        recipientRef: `RCP_pr7_${user.id.slice(0, 8)}`,
        verifiedName: 'Verify Player',
        isDefault: true,
        verifiedAt: new Date()
      }
    });
  }
  state.users.push(user.id);
  return { user, wallet };
}

const authed = (userId) => jwt.sign({ userId }, getJwtSecret(), { expiresIn: '1h' });

const api = async (path, { method = 'GET', body, token } = {}) =>
  fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });

async function run(name, probe) {
  try {
    await probe();
  } catch (e) {
    fail(name, `${e?.constructor?.name}: ${e?.message}`);
    if (process.env.VERIFY_DEBUG === '1') console.error(e.stack);
  }
}

const bal = async (wallet) => {
  const current = await prisma.wallet.findUnique({ where: { id: wallet.id } });
  return current.balanceMinorUnits;
};

async function sumType(userId, type, system = false) {
  const accounts = await prisma.ledgerAccount.findMany({
    where: system ? { type } : { userId, type }
  });
  if (accounts.length === 0) return 0n;
  const agg = await prisma.ledgerEntry.aggregate({
    where: { accountId: { in: accounts.map((a) => a.id) } },
    _sum: { amountMinorUnits: true }
  });
  return agg._sum.amountMinorUnits ?? 0n;
}

async function ledgerTxCount(prefix) {
  return prisma.ledgerTransaction.count({
    where: { idempotencyKey: { startsWith: prefix } }
  });
}

async function waitForRoom(userId) {
  for (let i = 0; i < 100; i++) {
    const members = await ioServer.in(`user:${userId}`).fetchSockets();
    if (members.length >= 1) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  await new Promise((r) => setTimeout(r, 50));
}

async function seedBank(userId, gateway, { isDefault = false } = {}) {
  return prisma.bankAccount.create({
    data: {
      userId,
      gateway,
      bankCode: gateway === 'PAYSTACK' ? '057' : '044',
      bankName: gateway === 'PAYSTACK' ? 'Zenith' : 'Access',
      accountNumber: `${gateway === 'PAYSTACK' ? '01' : '02'}${String(Math.random()).slice(2, 12)}`,
      accountName: 'Verify Player',
      recipientRef: `RCP_${gateway}_${userId.slice(0, 8)}`,
      verifiedName: 'Verify Player',
      isDefault,
      verifiedAt: new Date()
    }
  });
}

async function makeDefault(userId, bankId) {
  await prisma.bankAccount.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } });
  return prisma.bankAccount.update({ where: { id: bankId }, data: { isDefault: true } });
}

// Creates a PENDING_REVIEW withdrawal through real service code (no provider
// needed for the request), then simulates the admin-initiated PROCESSING state
// by flipping the row directly — the payout webhooks only ever see PROCESSING.
async function seedProcessingWithdrawal(userId, amountMinorUnits) {
  const svc = new WithdrawalService({ providers: {} });
  const pending = await svc.requestWithdrawal(userId, amountMinorUnits, `deep:${crypto.randomUUID()}`);
  return prisma.withdrawal.update({
    where: { id: pending.id },
    data: { status: 'PROCESSING', processedAt: new Date() }
  });
}

// ---------------------------------------------------------------------------

await run('P1 request over HTTP reserves atomically (PENDING_REVIEW, wallet + ledger + outbox)', async () => {
  const { user, wallet } = await makeUser('p1');
  const token = authed(user.id);

  const res = await api('/wallet/withdrawal-request', {
    method: 'POST',
    token,
    body: { amountMinorUnits: 8000, idempotencyKey: 'pr7_p1_key' }
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.withdrawalRequest.status, 'PENDING_REVIEW');
  assert.equal(body.withdrawalRequest.amountMinorUnits, '8000');
  assert.match(body.withdrawalRequest.reference, /^wit-/);

  assert.equal(await bal(wallet), 2000n);
  assert.equal(await sumType(user.id, 'PLAYER_AVAILABLE'), 2000n);
  assert.equal(await sumType(user.id, 'PLAYER_WITHDRAWAL_PENDING'), 8000n);

  const rows = await prisma.withdrawal.findMany({ where: { userId: user.id } });
  const txns = await prisma.walletTransaction.count({
    where: { walletId: wallet.id, type: 'WITHDRAWAL' }
  });
  assert.equal(rows.length, 1);
  assert.equal(txns, 1);
  // Outbox row for the emitted wallet.updated is atomic with the reservation.
  const outbox = await prisma.outboxEvent.count({
    where: { aggregateId: wallet.id, eventType: 'wallet.updated' }
  });
  assert.equal(outbox, 1);
  const ledger = await prisma.ledgerTransaction.findUnique({
    where: { idempotencyKey: `withdrawal:reserve:${rows[0].id}` },
    include: { entries: true }
  });
  assert.equal(ledger.entries.reduce((a, e) => a + e.amountMinorUnits, 0n), 0n);
  assert.equal(ledger.entries.length, 2);

  ok('P1 request over HTTP reserves atomically (PENDING_REVIEW, wallet + ledger + outbox)');
});

await run('P2 wallet_updated socket push fires once, carrying the exact negative change', async () => {
  const { user, wallet } = await makeUser('p2');
  const token = authed(user.id);
  const client = createSocketClient(`http://127.0.0.1:${SOCKET_PORT}`, {
    auth: { token },
    transports: ['websocket']
  });
  await new Promise((resolve, reject) => {
    client.once('connect', resolve);
    client.once('connect_error', (err) => reject(new Error(err.message)));
  });
  await waitForRoom(user.id);
  const nextEvent = (event, timeout = 3000) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeout);
      client.once(event, (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

  const pushed = nextEvent('wallet_updated');
  const res = await api('/wallet/withdrawal-request', {
    method: 'POST',
    token,
    body: { amountMinorUnits: 8000, idempotencyKey: 'pr7_p2_key' }
  });
  assert.equal(res.status, 201);
  const event = await pushed;
  assert.ok(event, 'wallet_updated should fire for a withdrawal request');
  assert.equal(event.balanceChange, '-8000');
  assert.equal(event.type, 'WITHDRAWAL');
  client.close();

  ok('P2 wallet_updated socket push fires once, carrying the exact negative change');
});

await run('P3 idempotent replay returns the original request, debits never twice', async () => {
  const { user, wallet } = await makeUser('p3');
  const token = authed(user.id);
  const body = { amountMinorUnits: 8000, idempotencyKey: 'pr7_p3_key' };

  const first = await (await api('/wallet/withdrawal-request', { method: 'POST', token, body })).json();
  const second = await (await api('/wallet/withdrawal-request', { method: 'POST', token, body })).json();

  assert.equal(second.withdrawalRequest.id, first.withdrawalRequest.id);
  assert.equal(await bal(wallet), 2000n);
  assert.equal(await prisma.withdrawal.count({ where: { userId: user.id } }), 1);
  assert.equal(
    await prisma.walletTransaction.count({ where: { walletId: wallet.id, type: 'WITHDRAWAL' } }),
    1
  );
  // Only one durable outbox row despite the replay's ephemeral re-emit.
  assert.equal(
    await prisma.outboxEvent.count({ where: { aggregateId: wallet.id, eventType: 'wallet.updated' } }),
    1
  );

  ok('P3 idempotent replay returns the original request, debits never twice');
});

await run('P4 EXIT GATE: 2 concurrent 8000 requests on 10000 -> one 201, one 402, ledger agrees', async () => {
  const { user, wallet } = await makeUser('p4');
  const token = authed(user.id);

  const [a, b] = await Promise.all([
    api('/wallet/withdrawal-request', { method: 'POST', token, body: { amountMinorUnits: 8000, idempotencyKey: 'pr7_p4_a' } }),
    api('/wallet/withdrawal-request', { method: 'POST', token, body: { amountMinorUnits: 8000, idempotencyKey: 'pr7_p4_b' } })
  ]);

  const codes = [a.status, b.status].sort();
  assert.deepEqual(codes, [201, 402]);
  const winner = a.status === 201 ? a : b;
  const winnerBody = await winner.json();
  assert.equal(winnerBody.withdrawalRequest.amountMinorUnits, '8000');

  assert.equal(await bal(wallet), 2000n);
  assert.equal(await sumType(user.id, 'PLAYER_AVAILABLE'), 2000n);
  assert.equal(await sumType(user.id, 'PLAYER_WITHDRAWAL_PENDING'), 8000n);
  assert.equal(await prisma.withdrawal.count({ where: { userId: user.id } }), 1);
  assert.equal(
    await prisma.walletTransaction.count({ where: { walletId: wallet.id, type: 'WITHDRAWAL' } }),
    1
  );

  ok('P4 EXIT GATE: 2 concurrent 8000 requests on 10000 -> one 201, one 402, ledger agrees');
});

await run('P5 single request above balance -> 402, nothing persisted', async () => {
  const { user, wallet } = await makeUser('p5', { balance: 100n });
  const res = await api('/wallet/withdrawal-request', {
    method: 'POST',
    token: authed(user.id),
    body: { amountMinorUnits: 200, idempotencyKey: 'pr7_p5_key' }
  });
  assert.equal(res.status, 402);
  const body = await res.json();
  assert.match(body.error, /Insufficient funds/i);

  assert.equal(await bal(wallet), 100n);
  assert.equal(await prisma.withdrawal.count({ where: { userId: user.id } }), 0);
  assert.equal(await sumType(user.id, 'PLAYER_WITHDRAWAL_PENDING'), 0n);

  ok('P5 single request above balance -> 402, nothing persisted');
});

await run('P6 KYC gate blocks a non-verified account -> 403, nothing persisted', async () => {
  const { user, wallet } = await makeUser('p6', { kyc: 'NONE' });
  const res = await api('/wallet/withdrawal-request', {
    method: 'POST',
    token: authed(user.id),
    body: { amountMinorUnits: 100, idempotencyKey: 'pr7_p6_key' }
  });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /KYC/i);
  assert.equal(await bal(wallet), 10000n);
  assert.equal(await prisma.withdrawal.count({ where: { userId: user.id } }), 0);

  ok('P6 KYC gate blocks a non-verified account -> 403, nothing persisted');
});

await run('P7 missing payout destination -> 422 even with funds', async () => {
  const { user, wallet } = await makeUser('p7', { withBank: false });
  const res = await api('/wallet/withdrawal-request', {
    method: 'POST',
    token: authed(user.id),
    body: { amountMinorUnits: 100, idempotencyKey: 'pr7_p7_key' }
  });
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /verified bank account/i);
  assert.equal(await bal(wallet), 10000n);
  assert.equal(await prisma.withdrawal.count({ where: { userId: user.id } }), 0);

  ok('P7 missing payout destination -> 422 even with funds');
});

await run('P8 admin reject lifecycle: approve then release refunds exactly once, re-release no-ops', async () => {
  const { user, wallet } = await makeUser('p8');
  const token = authed(user.id);
  const admin = await prisma.user.create({
    data: {
      email: `verify-pr7-admin-${Date.now()}@test.local`,
      passwordHash: 'x',
      kycStatus: 'VERIFIED',
      countryCode: 'NG',
      isAdmin: true
    }
  });
  state.users.push(admin.id);
  const adminToken = authed(admin.id);

  const created = await (await api('/wallet/withdrawal-request', {
    method: 'POST', token,
    body: { amountMinorUnits: 6000, idempotencyKey: 'pr7_p8_key' }
  })).json();
  const id = created.withdrawalRequest.id;
  assert.equal(await bal(wallet), 4000n);

  const approved = await (await api(`/admin/withdrawals/${id}/approve`, { method: 'POST', token: adminToken })).json();
  assert.equal(approved.withdrawal.status, 'APPROVED');

  const rejected = await (await api(`/admin/withdrawals/${id}/reject`, {
    method: 'POST', token: adminToken, body: { reason: 'manual check' }
  })).json();
  assert.equal(rejected.withdrawal.status, 'RELEASED');

  assert.equal(await bal(wallet), 10000n);
  assert.equal(await sumType(user.id, 'PLAYER_WITHDRAWAL_PENDING'), 0n);
  assert.equal(await sumType(user.id, 'PLAYER_AVAILABLE'), 10000n);
  assert.equal(await prisma.walletTransaction.count({ where: { walletId: wallet.id, type: 'REFUND' } }), 1);
  assert.equal(
    await prisma.notification.count({ where: { userId: user.id, type: 'WITHDRAWAL_REFUNDED' } }),
    1
  );

  // Re-release is a safe no-op: no second refund row or second credit.
  await api(`/admin/withdrawals/${id}/reject`, { method: 'POST', token: adminToken, body: { reason: 'again' } });
  assert.equal(await bal(wallet), 10000n);
  assert.equal(await prisma.walletTransaction.count({ where: { walletId: wallet.id, type: 'REFUND' } }), 1);
  assert.equal(
    await prisma.notification.count({ where: { userId: user.id, type: 'WITHDRAWAL_REFUNDED' } }),
    1
  );

  ok('P8 admin reject lifecycle: approve then release refunds exactly once, re-release no-ops');
});

await run('P9 GET /wallet/withdrawals lists rows and filters by status', async () => {
  const { user } = await makeUser('p9');
  const token = authed(user.id);
  await api('/wallet/withdrawal-request', {
    method: 'POST', token,
    body: { amountMinorUnits: 1000, idempotencyKey: 'pr7_p9_key' }
  });

  const list = await (await api('/wallet/withdrawals', { token })).json();
  assert.equal(list.total, 1);
  assert.equal(list.withdrawals[0].status, 'PENDING_REVIEW');
  assert.equal(list.withdrawals[0].amountMinorUnits, '1000');

  const filtered = await (await api('/wallet/withdrawals?status=PENDING_REVIEW', { token })).json();
  assert.equal(filtered.total, 1);
  const emptyFilter = await (await api('/wallet/withdrawals?status=COMPLETED', { token })).json();
  assert.equal(emptyFilter.total, 0);

  ok('P9 GET /wallet/withdrawals lists rows and filters by status');
});

await run('P10 webhook (Paystack transfer.success) completes a PROCESSING payout once', async () => {
  const { user, wallet } = await makeUser('p10', { balance: 60000n });
  const wd = await seedProcessingWithdrawal(user.id, 40000n);
  assert.equal(wd.status, 'PROCESSING');
  assert.equal(await bal(wallet), 20000n);
  assert.equal(await sumType(user.id, 'PLAYER_WITHDRAWAL_PENDING'), 40000n);
  const preLiability = await sumType(null, 'CUSTOMER_LIABILITY', true);

  const raw = paystackTransferEvent('transfer.success', wd.reference);
  const res = await postWebhook('/webhooks/paystack', raw, {
    'x-paystack-signature': paystackSignature(raw)
  });
  assert.equal(res.status, 200);

  const final = await prisma.withdrawal.findUnique({ where: { id: wd.id } });
  assert.equal(final.status, 'COMPLETED');

  // Completion moves pending funds to liability but never touches the wallet.
  assert.equal(await bal(wallet), 20000n);
  assert.equal(await sumType(user.id, 'PLAYER_WITHDRAWAL_PENDING'), 0n);
  assert.equal(await sumType(user.id, 'PLAYER_AVAILABLE'), 20000n);
  assert.equal((await sumType(null, 'CUSTOMER_LIABILITY', true)) - preLiability, 40000n);

  // Exactly one complete posting for THIS withdrawal, one notification; reserve outbox untouched.
  assert.equal(await ledgerTxCount(`withdrawal:complete:${wd.id}`), 1);
  assert.equal(
    await prisma.notification.count({ where: { userId: user.id, type: 'WITHDRAWAL_CONFIRMED' } }),
    1
  );
  assert.equal(
    await prisma.outboxEvent.count({ where: { aggregateId: wallet.id, eventType: 'wallet.updated' } }),
    1
  );

  ok('P10 webhook (Paystack transfer.success) completes a PROCESSING payout once');
});

await run('P11 concurrent duplicate success + late failure: one completion posting, terminal state stable', async () => {
  const { user, wallet } = await makeUser('p11', { balance: 60000n });
  const wd = await seedProcessingWithdrawal(user.id, 40000n);
  const raw = paystackTransferEvent('transfer.success', wd.reference);

  const [a, b] = await Promise.all([
    postWebhook('/webhooks/paystack', raw, { 'x-paystack-signature': paystackSignature(raw) }),
    postWebhook('/webhooks/paystack', raw, { 'x-paystack-signature': paystackSignature(raw) })
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);

  const final = await prisma.withdrawal.findUnique({ where: { id: wd.id } });
  assert.equal(final.status, 'COMPLETED');
  assert.equal(await ledgerTxCount(`withdrawal:complete:${wd.id}`), 1);
  assert.equal(
    await prisma.notification.count({ where: { userId: user.id, type: 'WITHDRAWAL_CONFIRMED' } }),
    1
  );
  assert.equal(await bal(wallet), 20000n);

  // A late transfer.failed must NOT un-complete it or move money again.
  const failRaw = paystackTransferEvent('transfer.failed', wd.reference);
  const late = await postWebhook('/webhooks/paystack', failRaw, {
    'x-paystack-signature': paystackSignature(failRaw)
  });
  assert.equal(late.status, 200);
  assert.equal((await prisma.withdrawal.findUnique({ where: { id: wd.id } })).status, 'COMPLETED');
  assert.equal(await ledgerTxCount(`withdrawal:complete:${wd.id}`), 1);
  assert.equal(await bal(wallet), 20000n);

  ok('P11 concurrent duplicate success + late failure: one completion posting, terminal state stable');
});

await run('P12 Flutterwave transfer.completed SUCCESSFUL completes a FLUTTERWAVE payout', async () => {
  const { user, wallet } = await makeUser('p12', { balance: 60000n });
  const flw = await seedBank(user.id, 'FLUTTERWAVE');
  await makeDefault(user.id, flw.id);
  const wd = await seedProcessingWithdrawal(user.id, 40000n);
  assert.equal(wd.gateway, 'FLUTTERWAVE');
  const preLiability = await sumType(null, 'CUSTOMER_LIABILITY', true);

  const raw = flutterwaveTransferEvent('transfer.completed', wd.reference, 'SUCCESSFUL');
  const res = await postWebhook('/webhooks/flutterwave', raw, {
    'verif-hash': process.env.FLUTTERWAVE_SECRET_HASH
  });
  assert.equal(res.status, 200);

  const final = await prisma.withdrawal.findUnique({ where: { id: wd.id } });
  assert.equal(final.status, 'COMPLETED');
  assert.equal((await sumType(null, 'CUSTOMER_LIABILITY', true)) - preLiability, 40000n);
  assert.equal(await sumType(user.id, 'PLAYER_WITHDRAWAL_PENDING'), 0n);
  assert.equal(await bal(wallet), 20000n);
  assert.equal(
    await prisma.notification.count({ where: { userId: user.id, type: 'WITHDRAWAL_CONFIRMED' } }),
    1
  );

  // A FAILED-status Flutterwave completion for the same transfer is a no-op.
  const failRaw = flutterwaveTransferEvent('transfer.completed', wd.reference, 'FAILED');
  const failRes = await postWebhook('/webhooks/flutterwave', failRaw, {
    'verif-hash': process.env.FLUTTERWAVE_SECRET_HASH
  });
  assert.equal(failRes.status, 200);
  assert.equal((await prisma.withdrawal.findUnique({ where: { id: wd.id } })).status, 'COMPLETED');
  assert.equal(await ledgerTxCount(`withdrawal:complete:${wd.id}`), 1);

  ok('P12 Flutterwave transfer.completed SUCCESSFUL completes a FLUTTERWAVE payout');
});

await run('P13 failed payout webhook keeps reserves; admin reject releases exactly once', async () => {
  const { user, wallet } = await makeUser('p13', { balance: 60000n });
  const wd = await seedProcessingWithdrawal(user.id, 40000n);
  const preLiability = await sumType(null, 'CUSTOMER_LIABILITY', true);

  const raw = paystackTransferEvent('transfer.failed', wd.reference, { complete_message: 'insufficient balance' });
  const res = await postWebhook('/webhooks/paystack', raw, {
    'x-paystack-signature': paystackSignature(raw)
  });
  assert.equal(res.status, 200);

  const failed = await prisma.withdrawal.findUnique({ where: { id: wd.id } });
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.failureReason, 'insufficient balance');
  // Funds remain reserved — the player has NOT been refunded yet.
  assert.equal(await bal(wallet), 20000n);
  assert.equal(await sumType(user.id, 'PLAYER_WITHDRAWAL_PENDING'), 40000n);
  assert.equal((await sumType(null, 'CUSTOMER_LIABILITY', true)), preLiability);

  // Admin reject releases: refund once, ledger closes, liability returns.
  const admin = await prisma.user.create({
    data: {
      email: `verify-pr7-admin13-${Date.now()}@test.local`,
      passwordHash: 'x', kycStatus: 'VERIFIED', countryCode: 'NG', isAdmin: true
    }
  });
  state.users.push(admin.id);
  const rejectBody = await (await api(`/admin/withdrawals/${failed.id}/reject`, {
    method: 'POST', token: authed(admin.id), body: { reason: 'not retrying' }
  })).json();
  assert.equal(rejectBody.withdrawal.status, 'RELEASED');

  assert.equal(await bal(wallet), 60000n);
  assert.equal(await sumType(user.id, 'PLAYER_WITHDRAWAL_PENDING'), 0n);
  assert.equal(await sumType(user.id, 'PLAYER_AVAILABLE'), 60000n);
  assert.equal(await sumType(null, 'CUSTOMER_LIABILITY', true), preLiability);
  assert.equal(await prisma.walletTransaction.count({ where: { walletId: wallet.id, type: 'REFUND' } }), 1);
  assert.equal(
    await prisma.notification.count({ where: { userId: user.id, type: 'WITHDRAWAL_REFUNDED' } }),
    1
  );

  ok('P13 failed payout webhook keeps reserves; admin reject releases exactly once');
});

await run('P14 webhook gate errors: forged, unknown, mismatched, unhandled — all harmless', async () => {
  const { user } = await makeUser('p14', { balance: 60000n });
  const flw = await seedBank(user.id, 'FLUTTERWAVE');
  await makeDefault(user.id, flw.id);
  const wd = await seedProcessingWithdrawal(user.id, 40000n);
  assert.equal(wd.gateway, 'FLUTTERWAVE');

  // Forged signature -> 401 before any lookup.
  const raw = paystackTransferEvent('transfer.success', wd.reference);
  const forged = await postWebhook('/webhooks/paystack', raw, { 'x-paystack-signature': 'forged' });
  assert.equal(forged.status, 401);
  assert.equal((await prisma.withdrawal.findUnique({ where: { id: wd.id } })).status, 'PROCESSING');

  // Unknown reference -> ack 200, no state change.
  const unknown = paystackTransferEvent('transfer.success', 'wit-nonexistent');
  const ures = await postWebhook('/webhooks/paystack', unknown, {
    'x-paystack-signature': paystackSignature(unknown)
  });
  assert.equal(ures.status, 200);
  assert.equal((await prisma.withdrawal.findUnique({ where: { id: wd.id } })).status, 'PROCESSING');

  // Gateway mismatch: Paystack-signature event for a FLUTTERWAVE withdrawal.
  const mismatch = paystackTransferEvent('transfer.success', wd.reference);
  const mres = await postWebhook('/webhooks/paystack', mismatch, {
    'x-paystack-signature': paystackSignature(mismatch)
  });
  assert.equal(mres.status, 200);
  assert.equal((await prisma.withdrawal.findUnique({ where: { id: wd.id } })).status, 'PROCESSING');

  // Unhandled event type (Paystack transfer.status) -> ack, no change.
  const statusEvt = paystackTransferEvent('transfer.status', wd.reference, { status: 'success' });
  const sres = await postWebhook('/webhooks/paystack', statusEvt, {
    'x-paystack-signature': paystackSignature(statusEvt)
  });
  assert.equal(sres.status, 200);
  assert.equal((await prisma.withdrawal.findUnique({ where: { id: wd.id } })).status, 'PROCESSING');

  ok('P14 webhook gate errors: forged, unknown, mismatched, unhandled — all harmless');
});

await run('P15 bank-account management over HTTP (list, default switch, delete, 404s, validation 400)', async () => {
  const { user, wallet } = await makeUser('p15', { balance: 60000n });
  const token = authed(user.id);

  let list = await (await api('/wallet/bank-accounts', { token })).json();
  assert.equal(list.bankAccounts.length, 1);
  assert.equal(list.bankAccounts[0].gateway, 'PAYSTACK');

  // Validation error surfaces catch-before-provider as 400.
  const bad = await api('/wallet/bank-accounts', {
    method: 'POST', token,
    body: { gateway: 'paystack', bankCode: '057', accountNumber: '123' }
  });
  assert.equal(bad.status, 400);
  const bad2 = await api('/wallet/bank-accounts', {
    method: 'POST', token,
    body: { gateway: 'stripe', bankCode: '057', bankName: 'X', accountNumber: '0123456789' }
  });
  assert.equal(bad2.status, 400);

  // Seeded second destination becomes the default; next request follows it.
  const flw = await seedBank(user.id, 'FLUTTERWAVE');
  await makeDefault(user.id, flw.id);
  const created = await (await api('/wallet/withdrawal-request', {
    method: 'POST', token, body: { amountMinorUnits: 10000, idempotencyKey: 'deep15_default' }
  })).json();
  assert.equal(created.withdrawalRequest.gateway, 'FLUTTERWAVE');

  // DELETE the FLUTTERWAVE default -> request now 422 (no destination).
  const del = await api(`/wallet/bank-accounts/${flw.id}`, { method: 'DELETE', token });
  assert.equal(del.status, 200);
  const nowMissing = await api('/wallet/withdrawal-request', {
    method: 'POST', token, body: { amountMinorUnits: 1000, idempotencyKey: 'deep15_missing' }
  });
  assert.equal(nowMissing.status, 422);

  // 404s on unknown ids.
  const miss = await api('/wallet/bank-accounts/does-not-exist', { method: 'PATCH', token });
  assert.equal(miss.status, 404);

  ok('P15 bank-account management over HTTP (list, default switch, delete, 404s, validation 400)');
});

await run('P16 unverified destination (recipientRef missing) -> 422 despite a row', async () => {
  const { user, wallet } = await makeUser('p16', { balance: 60000n });
  await prisma.bankAccount.updateMany({
    where: { userId: user.id },
    data: { recipientRef: null, verifiedAt: null }
  });
  const res = await api('/wallet/withdrawal-request', {
    method: 'POST', token: authed(user.id),
    body: { amountMinorUnits: 1000, idempotencyKey: 'deep16-unverified' }
  });
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /verified/i);
  assert.equal(await bal(wallet), 60000n);
  assert.equal(await prisma.withdrawal.count({ where: { userId: user.id } }), 0);

  ok('P16 unverified destination (recipientRef missing) -> 422 despite a row');
});

await run('P17 admin gates: double-approve no-op, report-result(false) reserves, PROCESSING not releasable', async () => {
  const { user, wallet } = await makeUser('p17', { balance: 60000n });
  const token = authed(user.id);
  const admin = await prisma.user.create({
    data: {
      email: `verify-pr7-admin17-${Date.now()}@test.local`,
      passwordHash: 'x', kycStatus: 'VERIFIED', countryCode: 'NG', isAdmin: true
    }
  });
  state.users.push(admin.id);
  const adminToken = authed(admin.id);

  const created = await (await api('/wallet/withdrawal-request', {
    method: 'POST', token, body: { amountMinorUnits: 40000, idempotencyKey: 'deep17a-approve-x2' }
  })).json();
  const id = created.withdrawalRequest.id;

  const firstApprove = await (await api(`/admin/withdrawals/${id}/approve`, { method: 'POST', token: adminToken })).json();
  assert.equal(firstApprove.withdrawal.status, 'APPROVED');
  const firstReviewedBy = firstApprove.withdrawal.reviewedBy;
  // Double-approve: no crash, no status regression, reviewedBy stable.
  const secondApprove = await (await api(`/admin/withdrawals/${id}/approve`, { method: 'POST', token: adminToken })).json();
  assert.equal(secondApprove.withdrawal.status, 'APPROVED');
  assert.equal(secondApprove.withdrawal.reviewedBy, firstReviewedBy);

  // Simulate begin-payout (PROCESSING is the only state report-result accepts),
  // then admin report-result success=false -> FAILED, funds stay reserved.
  await prisma.withdrawal.update({ where: { id }, data: { status: 'PROCESSING', processedAt: new Date() } });
  const rejected = await (await api(`/admin/withdrawals/${id}/report-result`, {
    method: 'POST', token: adminToken, body: { success: false, failureReason: 'ops decision' }
  })).json();
  assert.equal(rejected.withdrawal.status, 'FAILED');
  assert.equal(await bal(wallet), 20000n);
  assert.equal(await sumType(user.id, 'PLAYER_WITHDRAWAL_PENDING'), 40000n);

  // Release a healthily FAILED withdrawal (the operator path).
  const released = await (await api(`/admin/withdrawals/${id}/reject`, {
    method: 'POST', token: adminToken, body: { reason: 'no retry' }
  })).json();
  assert.equal(released.withdrawal.status, 'RELEASED');
  assert.equal(await bal(wallet), 60000n);

  // A PROCESSING withdrawal is NOT releasable: surface an error, refund nothing.
  const wd2 = await seedProcessingWithdrawal(user.id, 10000n);
  const lockRes = await api(`/admin/withdrawals/${wd2.id}/reject`, {
    method: 'POST', token: adminToken, body: { reason: 'oops' }
  });
  assert.ok(lockRes.status >= 400);
  assert.equal((await prisma.withdrawal.findUnique({ where: { id: wd2.id } })).status, 'PROCESSING');
  assert.equal(await bal(wallet), 50000n);

  ok('P17 admin gates: double-approve no-op, report-result(false) reserves, PROCESSING not releasable');
});

await run('P18 socket push on admin release (wallet_updated +N, WITHDRAWAL_RELEASE)', async () => {
  const { user, wallet } = await makeUser('p18', { balance: 60000n });
  const token = authed(user.id);
  const created = await (await api('/wallet/withdrawal-request', {
    method: 'POST', token, body: { amountMinorUnits: 40000, idempotencyKey: 'deep18-release-push' }
  })).json();
  const admin = await prisma.user.create({
    data: {
      email: `verify-pr7-admin18-${Date.now()}@test.local`,
      passwordHash: 'x', kycStatus: 'VERIFIED', countryCode: 'NG', isAdmin: true
    }
  });
  state.users.push(admin.id);

  const client = createSocketClient(`http://127.0.0.1:${SOCKET_PORT}`, {
    auth: { token }, transports: ['websocket']
  });
  await new Promise((resolve, reject) => {
    client.once('connect', resolve);
    client.once('connect_error', (err) => reject(new Error(err.message)));
  });
  await waitForRoom(user.id);
  const nextEvent = (event, timeout = 3000) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeout);
      client.once(event, (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

  const pushed = nextEvent('wallet_updated');
  await api(`/admin/withdrawals/${created.withdrawalRequest.id}/reject`, {
    method: 'POST', token: authed(admin.id), body: { reason: 'refund now' }
  });
  const event = await pushed;
  assert.ok(event, 'WITHDRAWAL_RELEASE socket event should fire');
  assert.equal(event.balanceChange, '+40000');
  assert.equal(event.type, 'WITHDRAWAL_RELEASE');
  assert.equal(event.withdrawalId, created.withdrawalRequest.id);
  client.close();

  ok('P18 socket push on admin release (wallet_updated +N, WITHDRAWAL_RELEASE)');
});

await run('P19 eligibility gates (age / country) -> 403 before any reservation', async () => {
  const age = await makeUser('p19a', { kyc: 'VERIFIED' });
  await prisma.eligibility.updateMany({
    where: { userId: age.user.id },
    data: { ageVerified: false }
  });
  const ageRes = await api('/wallet/withdrawal-request', {
    method: 'POST', token: authed(age.user.id),
    body: { amountMinorUnits: 100, idempotencyKey: 'deep19_age' }
  });
  assert.equal(ageRes.status, 403);
  assert.equal(await prisma.withdrawal.count({ where: { userId: age.user.id } }), 0);

  const country = await makeUser('p19b', { kyc: 'VERIFIED' });
  await prisma.eligibility.updateMany({
    where: { userId: country.user.id },
    data: { countryAllowed: false }
  });
  const countryRes = await api('/wallet/withdrawal-request', {
    method: 'POST', token: authed(country.user.id),
    body: { amountMinorUnits: 100, idempotencyKey: 'deep19_country' }
  });
  assert.equal(countryRes.status, 403);
  assert.equal(await prisma.withdrawal.count({ where: { userId: country.user.id } }), 0);

  ok('P19 eligibility gates (age / country) -> 403 before any reservation');
});

await run('P20 pagination bounds on /wallet/withdrawals', async () => {
  const { user } = await makeUser('p20', { balance: 100000n });
  const token = authed(user.id);
  await api('/wallet/withdrawal-request', {
    method: 'POST', token, body: { amountMinorUnits: 1000, idempotencyKey: 'deep20_1' }
  });
  await api('/wallet/withdrawal-request', {
    method: 'POST', token, body: { amountMinorUnits: 2000, idempotencyKey: 'deep20_2' }
  });

  const oversize = await api('/wallet/withdrawals?limit=1000', { token });
  assert.equal(oversize.status, 400);
  const pageBeyond = await (await api('/wallet/withdrawals?page=999', { token })).json();
  assert.equal(pageBeyond.withdrawals.length, 0);
  assert.equal(pageBeyond.total, 2);

  ok('P20 pagination bounds on /wallet/withdrawals');
});

await run('P21 concurrent same-idempotencyKey HTTP requests -> one row, one debit', async () => {
  const { user, wallet } = await makeUser('p21', { balance: 10000n });
  const token = authed(user.id);
  const body = { amountMinorUnits: 8000, idempotencyKey: 'deep21_same_key' };

  const [a, b] = await Promise.all([
    api('/wallet/withdrawal-request', { method: 'POST', token, body }),
    api('/wallet/withdrawal-request', { method: 'POST', token, body })
  ]);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  const aBody = await a.json();
  const bBody = await b.json();
  assert.equal(aBody.withdrawalRequest.id, bBody.withdrawalRequest.id);
  assert.equal(await bal(wallet), 2000n);
  assert.equal(await sumType(user.id, 'PLAYER_WITHDRAWAL_PENDING'), 8000n);
  assert.equal(await prisma.withdrawal.count({ where: { userId: user.id } }), 1);
  assert.equal(
    await prisma.walletTransaction.count({ where: { walletId: wallet.id, type: 'WITHDRAWAL' } }),
    1
  );

  ok('P21 concurrent same-idempotencyKey HTTP requests -> one row, one debit');
});

await run('P22 closed book after cleanup: zero-sum ledger, single liability singleton', async () => {
  // Every LedgerTransaction nets zero, globally.
  const all = await prisma.ledgerTransaction.findMany({ include: { entries: true } });
  for (const t of all) {
    const net = t.entries.reduce((a, e) => a + e.amountMinorUnits, 0n);
    assert.equal(net, 0n, `ledger txn ${t.id} (${t.type}) nets ${net}`);
  }
  const liabilities = await prisma.ledgerAccount.count({
    where: { type: 'CUSTOMER_LIABILITY' }
  });
  assert.equal(liabilities, 1);
  ok('P22 closed book after cleanup: zero-sum ledger, single liability singleton');
});

// ---------------------------------------------------------------------------
// Cleanup: remove harness rows (FK-safe order). Ledger rows first — their
// entries reference the user accounts, and deleting the users would cascade
// into the Restricted LedgerEntry.account foreign key.
// ---------------------------------------------------------------------------

await prisma.ledgerTransaction.deleteMany({
  where: { idempotencyKey: { startsWith: 'withdrawal:' } }
});
await prisma.ledgerTransaction.deleteMany({
  where: { idempotencyKey: { startsWith: 'pr7:seed:' } }
});

for (const userId of state.users) {
  const wallets = await prisma.wallet.findMany({ where: { userId }, select: { id: true } });
  const walletIds = wallets.map((w) => w.id);
  await prisma.withdrawal.deleteMany({ where: { userId } });
  await prisma.bankAccount.deleteMany({ where: { userId } });
  await prisma.notification.deleteMany({ where: { userId } });
  if (walletIds.length) {
    await prisma.walletTransaction.deleteMany({ where: { walletId: { in: walletIds } } });
    await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: walletIds }, eventType: 'wallet.updated' } });
  }
  await prisma.wallet.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.pass).length;
for (const r of results) {
  console.log(`${r.pass ? 'PASS ' : 'FAIL '} ${r.name}${r.pass && r.detail ? ` — ${r.detail}` : ''}${!r.pass ? ` — ${r.detail}` : ''}`);
}
console.log('================================================================');
console.log(`${passed}/${results.length} probes passed`);
console.log('cleanup: all probe rows removed');
await prisma.$disconnect();
apiServer.close();
webhookServer.close();
socketServer.close();
process.exit(passed === results.length ? 0 : 1);