// Live-app e2e for PR 12: boots the REAL server (src/server.js — HTTP + real
// Socket.IO + every cron job including the outbox drainer, payout follow-up and
// financial reconciliation), drives a real Paystack webhook through it and
// watches the wallet_updated notification arrive via the RUNNING drainer, then
// proves SIGTERM exits 0 on the graceful path. Run from backend/:
//
//   DATABASE_URL=... REDIS_URL=... \
//   node --env-file=.env scripts/verify/pr12-app-e2e.mjs
//
// The child inherits the same DATABASE_URL/REDIS_URL; PORT is chosen here and
// passed explicitly. Probe rows are cleaned up at the end.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { io as createSocketClient } from 'socket.io-client';
import prisma from '../../src/utils/db.js';
import { getJwtSecret } from '../../src/utils/jwtEnv.js';
import { createDepositIntent } from '../../src/modules/wallet/service.js';

const PORT = 45445;
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const ok = (name) => results.push({ name, pass: true });
const fail = (name, detail) => results.push({ name, pass: false, detail });

const resultsOk = (name, detail) => { results.push({ name, pass: true, detail }); };

const run = async (name, probe) => {
  try {
    await probe();
    resultsOk(name);
  } catch (e) {
    fail(name, `${e?.constructor?.name}: ${e?.message}`);
    if (process.env.VERIFY_DEBUG === '1') console.error(e.stack);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const paystackSignature = (raw) =>
  crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(raw).digest('hex');

// ---------------------------------------------------------------------------

const child = spawn(
  process.execPath,
  ['--env-file=.env', 'src/server.js'],
  {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  }
);
let childOutput = '';
let exited = null;
child.stdout.on('data', (d) => { childOutput += d; });
child.stderr.on('data', (d) => { childOutput += d; });
child.on('exit', (code, signal) => { exited = { code, signal }; });

const waitExit = (ms) => new Promise((resolve) => {
  if (exited) return resolve(exited);
  const t = setTimeout(() => resolve(null), ms);
  child.once('exit', () => { clearTimeout(t); resolve(exited); });
});

// The drainer commits SENT milliseconds after the socket emit inside deliver,
// so a push can arrive before the settle lands. Poll briefly for SENT.
const waitSent = async (dedupeKey, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const row = await prisma.outboxEvent.findUnique({ where: { dedupeKey } });
    if (row?.status === 'SENT') return row;
    await sleep(100);
  }
  return prisma.outboxEvent.findUnique({ where: { dedupeKey } });
};

const waitHealth = async (attempts = 60) => {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${BASE}/health`, { headers: { connection: 'close' } });
      if (res.status === 200) {
        const body = await res.json();
        if (body.status === 'ok') return body;
      }
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error(`server did not come healthy (output: ${childOutput.slice(-500)})`);
};

await run('E1 real server boots healthy with all jobs scheduled', async () => {
  const health = await waitHealth();
  assert.equal(health.status, 'ok');
  assert.equal(health.db, 'ok');
  assert.equal(health.redis, 'ok');
  assert.match(childOutput, /Server is running on port \d+/);
});

let e2e = {};
await run('E2 durable round-trip: webhook -> outbox -> drainer -> socket push', async () => {
  const user = await prisma.user.create({
    data: {
      email: `pr12-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`,
      passwordHash: 'x',
      kycStatus: 'VERIFIED',
      countryCode: 'NG',
      eligibility: { create: { countryCode: 'NG', countryAllowed: true, ageVerified: true } }
    }
  });
  const wallet = await prisma.wallet.create({ data: { userId: user.id } });
  e2e = { user, wallet };
  const intent = await createDepositIntent(user.id, 40_000n, 'PAYSTACK');
  e2e.intent = intent;

  const token = jwt.sign({ userId: user.id }, getJwtSecret(), { expiresIn: '1h' });
  const client = createSocketClient(`http://127.0.0.1:${PORT}`, {
    auth: { token },
    transports: ['websocket']
  });
  e2e.client = client;

  await new Promise((resolve, reject) => {
    client.once('connect', resolve);
    client.once('connect_error', (err) => reject(new Error(err.message)));
  });
  // give the connection handler time to join the personal room
  await sleep(1000);

  const body = JSON.stringify({
    event: 'charge.success',
    data: {
      reference: intent.reference,
      amount: 40000,
      currency: 'NGN',
      metadata: { userId: user.id }
    }
  });

  const pushed = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 10_000);
    client.once('wallet_updated', (payload) => { clearTimeout(timer); resolve(payload); });
  });

  const res = await fetch(`${BASE}/webhooks/paystack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-paystack-signature': paystackSignature(body), connection: 'close' },
    body
  });
  assert.equal(res.status, 200);
  assert.equal((await res.text()).trim(), 'OK');

  const payload = await pushed;
  assert.ok(payload, 'wallet_updated should arrive via the running drainer');
  assert.equal(payload.balanceChange, '40000');
  assert.equal(payload.type, 'DEPOSIT');

  // the drainer (claim -> deliver -> SENT) settled BOTH durable rows in the DB
  const walletRow = await waitSent(`wallet:deposit:${intent.id}`);
  const noticeRow = await waitSent(`notify:deposit:${intent.id}`);
  assert.equal(walletRow.status, 'SENT');
  assert.equal(noticeRow.status, 'SENT');
  assert.equal(await prisma.notification.count({ where: { userId: user.id, type: 'DEPOSIT_CONFIRMED' } }), 1);

  client.disconnect();
});

await run('E3 graceful SIGTERM stops cron jobs and exits 0', async () => {
  // wait for the guard (shuttingDown) to be clean; child may already be mid-cycle
  assert.ok(child, 'child alive');
  child.kill('SIGTERM');
  const result = await waitExit(10_000);
  // Graceful shutdown exits via process.exit(0) (in the server.close callback,
  // or the 5s unref'd safety net while keep-alive drains) — so assert the exit
  // CODE is 0, not a signal, plus the shutdown logs.
  assert.ok(result, 'child should exit within the 5s safety net');
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.match(childOutput, /SIGTERM signal received: stopping jobs and closing HTTP server/);
});

// ---------------------------------------------------------------------------

console.log(`\n${'='.repeat(64)}`);
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `  [${r.detail}]`}`);
}
console.log('='.repeat(64));
const failed = results.filter((r) => !r.pass).length;
console.log(`${results.length - failed}/${results.length} probes passed\n`);

if (failed > 0) {
  console.log('--- child server output ---');
  console.log(childOutput.slice(-4000));
  console.log('--- end child server output ---');
}

// Cleanup the probe rows (child is already dead).
let finalExit = failed > 0 ? 1 : 0;
try {
  if (e2e.user) {
    if (e2e.intent) {
      await prisma.ledgerEntry.deleteMany({ where: { transaction: { metadata: { path: ['depositIntentId'], equals: e2e.intent.id } } } });
      await prisma.ledgerTransaction.deleteMany({ where: { metadata: { path: ['depositIntentId'], equals: e2e.intent.id } } });
      await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: [e2e.wallet.id, ...(await prisma.notification.findMany({ where: { userId: e2e.user.id }, select: { id: true } })).map((n) => n.id)] } } });
    }
    await prisma.notification.deleteMany({ where: { userId: e2e.user.id } });
    await prisma.depositIntent.deleteMany({ where: { userId: e2e.user.id } });
    await prisma.wallet.deleteMany({ where: { userId: e2e.user.id } });
    await prisma.user.deleteMany({ where: { id: e2e.user.id } });
  }
  console.log('cleanup: probe rows removed');
} catch (e) {
  console.error('cleanup failed:', e.message);
  finalExit = 2;
}

await prisma.$disconnect();
process.exit(finalExit);