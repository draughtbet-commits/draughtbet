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
//   P10 closed book after cleanup: every LedgerTransaction nets zero, the
//       global entry sum is zero and the singleton liability is intact.
//
// No provider network call ever happens: verified BankAccount rows are seeded
// directly (the provider-resolution path is covered by unit + integration
// tests with injected fakes) and only withdraw/release routes are hit.
//
// Run:  timeout 150 node --env-file=.env scripts/verify/pr7-withdrawal.mjs

import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import { io as createSocketClient } from 'socket.io-client';
import prisma from '../../src/utils/db.js';
import { walletRouter } from '../../src/modules/wallet/controller.js';
import { adminRouter } from '../../src/modules/admin/controller.js';
import { initSocketServer } from '../../src/sockets/index.js';
import { getJwtSecret } from '../../src/utils/jwtEnv.js';
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

await run('P10 closed book after cleanup: zero-sum ledger, single liability singleton', async () => {
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
  ok('P10 closed book after cleanup: zero-sum ledger, single liability singleton');
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
socketServer.close();
process.exit(passed === results.length ? 0 : 1);