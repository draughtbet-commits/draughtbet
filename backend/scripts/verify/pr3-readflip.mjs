// PR 3 — V2 read-flip deep verification (real HTTP + PostgreSQL)
//
// PR 3 flips every user-facing balance/feed/profile read off the legacy
// Wallet mirror and onto the V2 ledger, then drops the mirror entirely
// (`Wallet.balanceMinorUnits`, the `WalletTransaction` table and the
// `TxType`/`TxStatus` enums). This harness pins the flipped read surface:
//   P1  GET /wallet/balance is the ledger PLAYER_AVAILABLE net (not a wallet
//       column) and moves when only a ledger posting happens
//   P2  GET /wallet/transactions emits the exact Flutter payload shape
//       (id, type, amountMinorUnits, status, createdAt, relatedMatchId)
//   P3  internal ADJUSTMENT legs are hidden from the feed AND from `total`,
//       yet still count toward the balance
//   P4  ledger -> feed type/sign mapping: STAKE_LOCK->STAKE(-), a decided
//       match win->PAYOUT(+), a draw->REFUND(+)
//   P5  GET /auth/me.walletBalanceMinorUnits is the same ledger net
//   P6  MIRROR TEARDOWN: Wallet has no balanceMinorUnits column, the
//       WalletTransaction table is gone and TxType/TxStatus enums are dropped
//   P7  closed book: every LedgerTransaction still nets zero
//   P8  pagination bounds on /wallet/transactions (oversize/zero limit -> 400)
//   P9  unauthenticated balance/transactions requests -> 401
//
// Run:  timeout 150 node --env-file=.env scripts/verify/pr3-readflip.mjs

import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../../src/utils/db.js';
import { walletRouter } from '../../src/modules/wallet/controller.js';
import { authRouter } from '../../src/modules/auth/controller.js';
import { getJwtSecret } from '../../src/utils/jwtEnv.js';
import {
  ensureUserAccounts,
  ensureSystemAccount,
  postLedgerTransaction,
  postDepositCredit,
  getLedgerAvailable
} from '../../src/services/ledgerService.js';

const app = express();
app.use(express.json());
app.use('/wallet', walletRouter);
app.use('/auth', authRouter);
const server = app.listen(0);
const API_BASE = `http://127.0.0.1:${server.address().port}`;

const state = { users: [] };
const results = [];

const ok = (name, detail = '') => results.push({ name, pass: true, detail });
const fail = (name, detail) => results.push({ name, pass: false, detail });

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

async function makeUser(suffix, { deposit = 50000n } = {}) {
  const user = await prisma.user.create({
    data: {
      email: `verify-pr3-${Date.now()}-${Math.random().toString(36).slice(2)}-${suffix}@test.local`,
      passwordHash: 'x',
      kycStatus: 'VERIFIED',
      countryCode: 'NG',
      isAdmin: false,
      eligibility: {
        create: { countryCode: 'NG', countryAllowed: true, ageVerified: true }
      }
    }
  });
  await prisma.wallet.create({ data: { userId: user.id } });
  if (deposit > 0n) {
    await postDepositCredit(prisma, {
      userId: user.id,
      amountMinorUnits: deposit,
      reference: `pr3-dep-${user.id.slice(0, 8)}`
    });
  }
  state.users.push(user.id);
  return user;
}

const ledgerBalance = (userId) => getLedgerAvailable(prisma, userId, 'NGN');

const feed = async (userId) => {
  const res = await api('/wallet/transactions', { token: authed(userId) });
  assert.equal(res.status, 200);
  return res.json();
};

// ---------------------------------------------------------------------------
// P1 — balance is the ledger net, not a wallet column.
// ---------------------------------------------------------------------------

await run('P1 GET /wallet/balance reads the ledger PLAYER_AVAILABLE net', async () => {
  const user = await makeUser('p1', { deposit: 50000n });

  const res = await api('/wallet/balance', { token: authed(user.id) });
  assert.equal(res.status, 200);
  const { balance } = await res.json();
  assert.deepEqual(balance, { currency: 'NGN', balanceMinorUnits: '50000' });
  assert.equal(await ledgerBalance(user.id), 50000n);

  // A pure ledger posting (no wallet write anywhere) must move the read.
  await postDepositCredit(prisma, {
    userId: user.id,
    amountMinorUnits: 25000n,
    reference: `pr3-p1b-${user.id.slice(0, 8)}`
  });

  const res2 = await api('/wallet/balance', { token: authed(user.id) });
  const { balance: balance2 } = await res2.json();
  assert.equal(balance2.balanceMinorUnits, '75000');
  assert.equal(await ledgerBalance(user.id), 75000n);
  ok('P1 GET /wallet/balance reads the ledger PLAYER_AVAILABLE net');
});

// ---------------------------------------------------------------------------
// P2 — the feed emits the exact Flutter payload shape.
// ---------------------------------------------------------------------------

await run('P2 GET /wallet/transactions emits the Flutter payload shape', async () => {
  const user = await makeUser('p2', { deposit: 40000n });
  const body = await feed(user.id);
  assert.ok(Array.isArray(body.transactions));
  assert.equal(body.total >= 1, true);

  const row = body.transactions.find((t) => t.type === 'DEPOSIT');
  assert.ok(row, 'expected a DEPOSIT row');
  assert.deepEqual(Object.keys(row).sort(), [
    'amountMinorUnits',
    'createdAt',
    'id',
    'relatedMatchId',
    'status',
    'type'
  ]);
  assert.equal(row.amountMinorUnits, '40000');
  assert.equal(row.status, 'COMPLETED');
  assert.equal(row.relatedMatchId, null);
  assert.equal(typeof row.id, 'string');
  assert.ok(!Number.isNaN(Date.parse(row.createdAt)));
  ok('P2 GET /wallet/transactions emits the Flutter payload shape');
});

// ---------------------------------------------------------------------------
// P3 — ADJUSTMENT legs are internal: hidden from feed + total, counted in balance.
// ---------------------------------------------------------------------------

await run('P3 ADJUSTMENT legs hidden from feed and total, still in balance', async () => {
  const user = await makeUser('p3', { deposit: 30000n });
  const accounts = await ensureUserAccounts(prisma, user.id, 'NGN');
  const clearing = await ensureSystemAccount(prisma, 'SYSTEM_OPENING_CLEARING', 'NGN');
  await postLedgerTransaction(prisma, {
    type: 'ADJUSTMENT',
    description: 'pr3 opening backfill',
    idempotencyKey: `pr3:adjust:${user.id}`,
    entries: [
      { accountId: accounts.PLAYER_AVAILABLE.id, amountMinorUnits: 7000n },
      { accountId: clearing.id, amountMinorUnits: -7000n }
    ]
  });

  const body = await feed(user.id);
  assert.equal(body.transactions.some((t) => t.type === 'ADJUSTMENT'), false);
  assert.equal(body.total, 1);

  const res = await api('/wallet/balance', { token: authed(user.id) });
  const { balance } = await res.json();
  assert.equal(balance.balanceMinorUnits, '37000');
  assert.equal(await ledgerBalance(user.id), 37000n);
  ok('P3 ADJUSTMENT legs hidden from feed and total, still in balance');
});

// ---------------------------------------------------------------------------
// P4 — ledger -> feed mapping for stake / win / draw.
// ---------------------------------------------------------------------------

await run('P4 STAKE_LOCK->STAKE(-), win->PAYOUT(+), draw->REFUND(+)', async () => {
  const user = await makeUser('p4', { deposit: 100000n });
  const accounts = await ensureUserAccounts(prisma, user.id, 'NGN');
  const clearing = await ensureSystemAccount(prisma, 'SYSTEM_OPENING_CLEARING', 'NGN');

  await postLedgerTransaction(prisma, {
    type: 'STAKE_LOCK',
    description: 'pr3 stake',
    idempotencyKey: `pr3:stake:${user.id}`,
    relatedMatchId: `pr3-match-stake-${user.id.slice(0, 8)}`,
    entries: [
      { accountId: accounts.PLAYER_AVAILABLE.id, amountMinorUnits: -50000n },
      { accountId: accounts.PLAYER_LOCKED.id, amountMinorUnits: 50000n }
    ]
  });
  await postLedgerTransaction(prisma, {
    type: 'SETTLEMENT_PAYOUT',
    description: 'pr3 win',
    idempotencyKey: `pr3:win:${user.id}`,
    relatedMatchId: `pr3-match-win-${user.id.slice(0, 8)}`,
    metadata: { winnerId: user.id },
    entries: [
      { accountId: accounts.PLAYER_AVAILABLE.id, amountMinorUnits: 90000n },
      { accountId: clearing.id, amountMinorUnits: -90000n }
    ]
  });
  await postLedgerTransaction(prisma, {
    type: 'SETTLEMENT_PAYOUT',
    description: 'pr3 draw refund',
    idempotencyKey: `pr3:draw:${user.id}`,
    relatedMatchId: `pr3-match-draw-${user.id.slice(0, 8)}`,
    metadata: {},
    entries: [
      { accountId: accounts.PLAYER_AVAILABLE.id, amountMinorUnits: 50000n },
      { accountId: clearing.id, amountMinorUnits: -50000n }
    ]
  });

  const body = await feed(user.id);

  const stake = body.transactions.find((t) => t.type === 'STAKE');
  assert.ok(stake, 'expected a STAKE row');
  assert.equal(stake.amountMinorUnits, '-50000');
  assert.equal(stake.status, 'COMPLETED');
  assert.match(stake.relatedMatchId, /^pr3-match-stake-/);

  const payouts = body.transactions.filter((t) => t.type === 'PAYOUT');
  assert.equal(payouts.length, 1);
  assert.equal(payouts[0].amountMinorUnits, '90000');
  assert.equal(payouts[0].status, 'COMPLETED');
  assert.match(payouts[0].relatedMatchId, /^pr3-match-win-/);

  const refunds = body.transactions.filter((t) => t.type === 'REFUND');
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].amountMinorUnits, '50000');
  assert.match(refunds[0].relatedMatchId, /^pr3-match-draw-/);

  ok('P4 STAKE_LOCK->STAKE(-), win->PAYOUT(+), draw->REFUND(+)');
});

// ---------------------------------------------------------------------------
// P5 — /auth/me profile balance is the same ledger net.
// ---------------------------------------------------------------------------

await run('P5 GET /auth/me.walletBalanceMinorUnits is the ledger net', async () => {
  const user = await makeUser('p5', { deposit: 12345n });
  const res = await api('/auth/me', { token: authed(user.id) });
  assert.equal(res.status, 200);
  const profile = await res.json();
  assert.equal(profile.id, user.id);
  assert.equal(profile.walletBalanceMinorUnits, '12345');
  assert.equal(await ledgerBalance(user.id), 12345n);
  ok('P5 GET /auth/me.walletBalanceMinorUnits is the ledger net');
});

// ---------------------------------------------------------------------------
// P6 — mirror teardown at the schema level.
// ---------------------------------------------------------------------------

await run('P6 Wallet.balanceMinorUnits and WalletTransaction/TxType are gone', async () => {
  const cols = await prisma.$queryRawUnsafe(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'Wallet'`
  );
  assert.equal(cols.some((c) => c.column_name === 'balanceMinorUnits'), false);

  const tables = await prisma.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'WalletTransaction'`
  );
  assert.equal(tables.length, 0);

  const enums = await prisma.$queryRawUnsafe(
    `SELECT typname FROM pg_type WHERE typname IN ('TxType', 'TxStatus')`
  );
  assert.equal(enums.length, 0);
  ok('P6 Wallet.balanceMinorUnits and WalletTransaction/TxType are gone');
});

// ---------------------------------------------------------------------------
// P7 — closed book.
// ---------------------------------------------------------------------------

await run('P7 closed book: every LedgerTransaction nets zero', async () => {
  const all = await prisma.ledgerTransaction.findMany({ include: { entries: true } });
  for (const t of all) {
    const net = t.entries.reduce((a, e) => a + e.amountMinorUnits, 0n);
    assert.equal(net, 0n, `ledger txn ${t.id} (${t.type}) nets ${net}`);
  }
  ok('P7 closed book: every LedgerTransaction nets zero');
});

// ---------------------------------------------------------------------------
// P8 — pagination bounds.
// ---------------------------------------------------------------------------

await run('P8 pagination bounds: oversize/zero limit -> 400', async () => {
  const user = await makeUser('p8', { deposit: 1000n });
  const token = authed(user.id);

  for (const qs of ['limit=101', 'limit=0', 'page=0']) {
    const res = await api(`/wallet/transactions?${qs}`, { token });
    assert.equal(res.status, 400, `${qs} should be rejected`);
  }

  const good = await api('/wallet/transactions?limit=1&page=1', { token });
  assert.equal(good.status, 200);
  const body = await good.json();
  assert.equal(body.page, 1);
  assert.equal(body.transactions.length <= 1, true);
  ok('P8 pagination bounds: oversize/zero limit -> 400');
});

// ---------------------------------------------------------------------------
// P9 — auth gates.
// ---------------------------------------------------------------------------

await run('P9 unauthenticated balance/transactions -> 401', async () => {
  for (const path of ['/wallet/balance', '/wallet/transactions']) {
    const res = await api(path);
    assert.equal(res.status, 401, `${path} should require auth`);
  }
  ok('P9 unauthenticated balance/transactions -> 401');
});

// ---------------------------------------------------------------------------
// Cleanup: ledger rows first (Restricted FK to player accounts), then users.
// ---------------------------------------------------------------------------

await prisma.ledgerTransaction.deleteMany({ where: { idempotencyKey: { contains: 'pr3' } } });
await prisma.ledgerTransaction.deleteMany({ where: { relatedMatchId: { contains: 'pr3' } } });

for (const userId of state.users) {
  await prisma.wallet.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.pass).length;
for (const r of results) {
  console.log(
    `${r.pass ? 'PASS ' : 'FAIL '} ${r.name}${r.pass && r.detail ? ` — ${r.detail}` : ''}${!r.pass ? ` — ${r.detail}` : ''}`
  );
}
console.log('================================================================');
console.log(`${passed}/${results.length} probes passed`);
console.log('cleanup: all probe rows removed');
await prisma.$disconnect();
server.close();
process.exit(passed === results.length ? 0 : 1);
