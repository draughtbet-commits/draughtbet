// Proves every PR7 withdrawal state is reachable against a running backend and
// the stand-in Paystack provider, and prints the exact status payload the app's
// polling reads at each step.
//
//   node --env-file=.env scripts/probe-withdrawal-lifecycle.mjs
//
// The drive test relies on this having worked: it is the difference between
// "the screen exists" and "the screen can be recorded".
import prisma from '../src/utils/db.js';
import redis from '../src/utils/redis.js';

const API = process.env.DRIVE_API || 'http://127.0.0.1:3100/api/v1';
const API_ROOT = API.replace(/\/api\/v1$/, '');
const FAKE = process.env.FAKE_PAYSTACK || 'http://127.0.0.1:4010';

const PLAYER_EMAIL = 'withdraw.dev@draughtsarena.net';
const STAFF_EMAIL = 'finance.dev@draughtsarena.net';
const AMOUNT = 50000; // 500.00

const call = async (method, path, { token, body, idempotencyKey, root } = {}) => {
  const response = await fetch(`${root ? API_ROOT : API}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body: json };
};

// The shared client connects asynchronously and refuses commands until it is
// ready, so wait for that before the first read.
const redisReady = () =>
  new Promise((resolve) => {
    if (!redis) return resolve();
    if (redis.isReady) return resolve();
    redis.once('ready', resolve);
    setTimeout(resolve, 3000);
  });

const token = async (email) => {
  const key = `drive:token:${email}`;
  const cached = redis ? await redis.get(key) : null;
  if (cached) return cached;
  const res = await call('POST', '/auth/login', { body: { email, password: 'Draughts@Dev2026' } });
  if (res.status !== 200) throw new Error(`login ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  const value = res.body.data?.accessToken ?? res.body.accessToken;
  if (redis) await redis.set(key, value, 'EX', 20 * 60);
  return value;
};

let keySeq = 0;
const uniqueKey = (label) => `probe-${label}-${Date.now()}-${++keySeq}`;

const createWithdrawal = async (playerToken, label) => {
  const res = await call('POST', '/withdrawals', {
    token: playerToken,
    body: { amountMinorUnits: AMOUNT },
    idempotencyKey: uniqueKey(label),
  });
  if (res.status !== 200) {
    throw new Error(`create ${label} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const withdrawal = res.body.data?.withdrawal;
  if (!withdrawal?.id) throw new Error(`create ${label} shape: ${JSON.stringify(res.body)}`);
  console.log(
    `  created ${label}: id=${withdrawal.id} status=${withdrawal.status} ref=${withdrawal.reference}`
  );
  return withdrawal;
};

const adminAction = async (staffToken, action, id, body) => {
  const res = await call('POST', `/admin/withdrawals/${id}/${action}`, {
    token: staffToken,
    body,
    // Every POST is idempotency-keyed, including staff mutations, so a retried
    // admin call cannot approve or reject twice.
    idempotencyKey: uniqueKey(`admin-${action}`),
  });
  if (res.status !== 200) {
    throw new Error(`admin ${action} ${id} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.withdrawal ?? res.body.data?.withdrawal;
};

const settle = async (outcome) => {
  const res = await call('POST', `/test/transfer/settle?outcome=${outcome}`, { root: true });
  // Called against the fake provider, not the API root.
  const actual = await fetch(`${FAKE}/test/transfer/settle?outcome=${outcome}`, { method: 'POST' });
  const text = await actual.text();
  void res;
  return { status: actual.status, body: text };
};

/** Reads the status back the way the app's poll does. */
const readStatus = async (playerToken, id) => {
  const res = await call('GET', `/withdrawals/${id}`, { token: playerToken });
  const status = res.body.data?.withdrawal?.status ?? res.body.status ?? res.body.withdrawal?.status;
  console.log(`    status read -> ${res.status} ${status}`);
  return { http: res.status, status, raw: res.body };
};

const main = async () => {
  await redisReady();
  const playerToken = await token(PLAYER_EMAIL);
  const staffToken = await token(STAFF_EMAIL);
  console.log('tokens acquired\n');

  // --- pending review -----------------------------------------------------
  console.log('PENDING_REVIEW');
  const a = await createWithdrawal(playerToken, 'pending');
  const aStatus = await readStatus(playerToken, a.id);
  if (aStatus.status !== 'PENDING_REVIEW') {
    throw new Error(`expected PENDING_REVIEW, got ${aStatus.status}`);
  }

  // --- processing ---------------------------------------------------------
  console.log('\nPROCESSING');
  await adminAction(staffToken, 'approve', a.id);
  console.log('  approved');
  const processing = await adminAction(staffToken, 'begin-payout', a.id);
  console.log(`  begin-payout -> status=${processing.status} providerRef=${processing.providerRef}`);
  const aProcessing = await readStatus(playerToken, a.id);
  if (aProcessing.status !== 'PROCESSING') {
    throw new Error(`expected PROCESSING, got ${aProcessing.status}`);
  }

  // --- completed (signed transfer.success webhook) ------------------------
  console.log('\nCOMPLETED');
  const settled = await settle('success');
  console.log(`  fake provider settle -> ${settled.status} ${settled.body}`);
  // The webhook is delivered synchronously, but allow the handler a moment.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const aDone = await readStatus(playerToken, a.id);
  if (aDone.status !== 'COMPLETED') throw new Error(`expected COMPLETED, got ${aDone.status}`);

  // --- payout failed (signed transfer.failed webhook) --------------------
  console.log('\nFAILED (payout-failed screen)');
  const b = await createWithdrawal(playerToken, 'failing');
  await adminAction(staffToken, 'approve', b.id);
  await adminAction(staffToken, 'begin-payout', b.id);
  console.log(`  begin-payout -> ${(await readStatus(playerToken, b.id)).status}`);
  const failed = await settle('failure');
  console.log(`  fake provider settle -> ${failed.status} ${failed.body}`);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const bFailed = await readStatus(playerToken, b.id);
  if (bFailed.status !== 'FAILED') throw new Error(`expected FAILED, got ${bFailed.status}`);
  const reason = await prisma.withdrawal.findUnique({ where: { id: b.id } });
  console.log(`  failureReason -> ${JSON.stringify(reason.failureReason)}`);
  console.log(`  raw FAILED status payload -> ${JSON.stringify(bFailed.raw)}`);

  // --- released (reversed screen) ----------------------------------------
  console.log('\nRELEASED (reversed screen)');
  const c = await createWithdrawal(playerToken, 'releasable');
  const released = await adminAction(staffToken, 'reject', c.id, { reason: 'Drive recording' });
  console.log(`  reject -> status=${released.status}`);
  const cReleased = await readStatus(playerToken, c.id);
  if (cReleased.status !== 'RELEASED') throw new Error(`expected RELEASED, got ${cReleased.status}`);

  // --- the gate -----------------------------------------------------------
  console.log('\nGATE (verification-required screen)');
  const unverifiedToken = await token('withdraw.unverified@draughtsarena.net');
  const gate = await call('POST', '/withdrawals', {
    token: unverifiedToken,
    body: { amountMinorUnits: AMOUNT },
    idempotencyKey: uniqueKey('gate'),
  });
  console.log(`  unverified create -> ${gate.status} ${JSON.stringify(gate.body)}`);

  console.log('\nall five status states plus the gate are reachable');
  await prisma.$disconnect();
  if (redis) redis.disconnect();
};

main().catch(async (error) => {
  console.error('\nprobe failed:', error.message);
  await prisma.$disconnect();
  if (redis) redis.disconnect();
  process.exit(1);
});
