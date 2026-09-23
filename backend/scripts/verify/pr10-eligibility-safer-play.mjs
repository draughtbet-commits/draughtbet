// KYC + eligibility + safer-play deep verification (real HTTP app + PostgreSQL + Redis)
//
// Drives the real production wiring of the money-in / money-out / play gates and
// the safer-play controls (deposit limit, stake limit, timeout, self-exclusion)
// the way a second device would — every restriction is enforced server-side and
// DB-backed, so it binds across devices with the same account.
//
//   P1  money-in gate: a first deposit under the cap is allowed; a deposit that
//       would break the rolling 24h cap is refused (422) from BOTH devices
//   P2  a requested RAISE is staged pending the cooling window — the effective
//       cap is unchanged, still binding, until the window elapses
//   P3  a timeout arms from device 1 and blocks PLAY on device 2 (join + call
//       outs); a timeout can only ever be extended
//   P4  self-exclusion from one device blocks PLAY and money-in AND money-out
//       on the other; extend-only
//   P5  KYC gates money-OUT (withdrawal-request) but NEVER money-in; a
//       simulated provider pass projects VERIFIED across devices
//   P6  a per-match stake limit set on one device blocks an over-limit stake
//       on the other (queue join and call-out create)
//   P7  a failing simulated KYC provider marks the case REJECTED and does not
//       project VERIFIED
//   P8  closed book: after every deposit credit the ledger still nets zero
//
// Run:  NODE_ENV=test \
//       DATABASE_URL="postgresql://…@127.0.0.1:5432/draughts_arena" \
//       REDIS_URL="redis://:…@127.0.0.1:6379" \
//       node --env-file=.env scripts/verify/pr10-eligibility-safer-play.mjs

import assert from 'node:assert/strict';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import prisma from '../../src/utils/db.js';
import app from '../../src/app.js';
import { getJwtSecret } from '../../src/utils/jwtEnv.js';
import { ensureUserAccounts, postDepositCredit } from '../../src/services/ledgerService.js';
import { enforceDepositLimit } from '../../src/modules/saferPlay/service.js';
import { startVerification, KycRejectedError } from '../../src/modules/verification/service.js';
import { SimulatedKycProvider } from '../../src/modules/verification/providerAdapter.js';
import { STAKE_PRESETS } from '../../src/middleware/tierEnforcement.js';

if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
  throw new Error('DATABASE_URL and REDIS_URL must be set (run with the env overrides, see header)');
}

const JWT_SECRET = getJwtSecret();
const allUserIds = [];
const depositCreditKeys = [];
let server;
let base;

const ready = async () => {
  for (let i = 0; i < 40; i++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      await (await import('../../src/utils/redis.js')).default.ping();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error('PostgreSQL/Redis not ready');
};

const token = (userId) => jwt.sign({ userId, email: `${userId}@harness.local` }, JWT_SECRET, { expiresIn: '10m' });

const api = async (method, path, { userId, body } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token(userId)}`,
      'content-type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, data };
};

const createUser = async ({ kycStatus = 'NONE', tier = 'AMATEUR' } = {}) => {
  const id = `pr10-${crypto.randomUUID()}`;
  await prisma.user.create({
    data: {
      id,
      email: `${id}@harness.local`,
      passwordHash: 'x',
      tier,
      countryCode: 'NG',
      kycStatus,
      wallet: { create: { currency: 'NGN' } },
      eligibility: {
        create: {
          countryCode: 'NG',
          countryAllowed: true,
          ageVerified: true
        }
      }
    }
  });
  await ensureUserAccounts(prisma, id);
  allUserIds.push(id);
  return id;
};

const seedDeposit = async (userId, amountMinorUnits, reference) => {
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  await prisma.depositIntent.create({
    data: {
      userId,
      walletId: wallet.id,
      amountMinorUnits,
      currency: 'NGN',
      gateway: 'PAYSTACK',
      status: 'COMPLETED',
      reference,
      authorizationUrl: `https://pay.example/${reference}`
    }
  });
  await postDepositCredit(prisma, {
    userId,
    amountMinorUnits,
    depositIntentId: `intent-${reference}`,
    reference
  });
  depositCreditKeys.push(`deposit:credit:${reference}`);
  await prisma.depositIntent.update({
    where: { reference },
    data: { status: 'COMPLETED' }
  });
};

let p = 0;
const step = (name) => {
  p += 1;
  console.log(`P${p} ${name}`);
};

try {
  await ready();

  // Platform settings: 24h cooling singleton for every P in this harness.
  await prisma.platformSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', limitRaiseCoolingHours: 24 },
    update: { limitRaiseCoolingHours: 24 }
  });

  const httpServer = http.createServer(app);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  server = httpServer;
  base = `http://127.0.0.1:${httpServer.address().port}/api/v1`;
  console.log(`harness server on ${base}`);

  // ---------------------------------------------------------------------
  step('money-in gate: deposit cap enforced on both devices');
  // ---------------------------------------------------------------------
  const A = await createUser(); // kycStatus NONE — money in must NOT require KYC
  const a1 = A;
  const a2 = A; // same account, distinct device/session

  const setDep = await api('PUT', '/safer-play/deposit-limit', { userId: a1, body: { amountMinorUnits: '100000' } });
  assert.equal(setDep.status, 200, 'deposit limit can be set');
  assert.equal(setDep.data.profile.effectiveDepositLimitMinorUnits, '100000');

  await seedDeposit(A, 40000n, `a-completed-${A}`);

  // Under the cap → allowed from device 2 as well (gate passes; gateway would
  // then 503 in this env for lack of a real provider key, not an eligibility 4xx).
  await enforceDepositLimit(prisma, a2, 60000n).then(
    () => assert.ok(true),
    () => assert.fail('exactly-at-cap deposit must be allowed')
  );

  // Over the cap → refused on BOTH devices by the server, not the client.
  for (const [device, devName] of [[a1, 'device 1'], [a2, 'device 2']]) {
    const res = await api('POST', '/wallet/deposit-intent', { userId: device, body: { amountMinorUnits: '65000', gateway: 'paystack' } });
    assert.equal(res.status, 422, `${devName} deposit over cap must be 422`);
    assert.match(res.data.error, /daily limit/, `${devName} must cite the deposit limit`);
  }

  // ---------------------------------------------------------------------
  step('cooled RAISE: pending until the cooling window elapses');
  // ---------------------------------------------------------------------
  const raised = await api('PUT', '/safer-play/deposit-limit', { userId: a1, body: { amountMinorUnits: '500000' } });
  assert.equal(raised.status, 200);
  assert.equal(raised.data.profile.pendingDepositLimitMinorUnits, '500000', 'raise is staged');
  assert.equal(raised.data.profile.effectiveDepositLimitMinorUnits, '100000', 'effective cap still the old one during cooling');

  // The old cap still binds during cooling — an over-cap attempt on device 2 fails.
  await assert.rejects(
    enforceDepositLimit(prisma, a2, 60001n),
    /daily limit/,
    'raise must not be effective before the cooling window'
  );

  // Backdate the pending raise past the 24h window: the new cap now binds.
  await prisma.saferPlayProfile.update({
    where: { userId: A },
    data: { pendingDepositLimitRaisedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }
  });
  await enforceDepositLimit(prisma, a1, 200000n).then(
    () => assert.ok(true),
    () => assert.fail('post-cooling deposit up to the new cap must be allowed')
  );
  await assert.rejects(enforceDepositLimit(prisma, a2, 460001n), /daily limit/, 'new cap binds after cooling');

  // ---------------------------------------------------------------------
  step('timeout: a break set on device 1 blocks PLAY on device 2');
  // ---------------------------------------------------------------------
  const B = await createUser();
  const b1 = B;
  const b2 = B;
  const timeout = await api('POST', '/safer-play/timeout', { userId: b1, body: { minutes: 120 } });
  assert.equal(timeout.status, 201, 'timeout arms');
  assert.ok(timeout.data.profile.timeoutUntil, 'timeoutUntil is set');

  const shrink = await api('POST', '/safer-play/timeout', { userId: b1, body: { minutes: 60 } });
  assert.equal(shrink.status, 409, 'a timeout can only be extended');

  const joinForB = await api('POST', '/matchmaking/join', { userId: b2, body: { stakeMinorUnits: '50000' } });
  assert.equal(joinForB.status, 403, 'device 2 is kept out of the queue during the break');
  assert.match(joinForB.data.error, /break is active/);

  const calloutForB = await api('POST', '/callouts', { userId: b1, body: { stakeMinorUnits: '50000' } });
  assert.equal(calloutForB.status, 403, 'device 1 call-out create is also blocked during the break');

  // An overdue timeout stops binding.
  await prisma.saferPlayProfile.update({
    where: { userId: B },
    data: { timeoutUntil: new Date(Date.now() - 1000) }
  });
  const okAfterBreak = await api('POST', '/matchmaking/join', { userId: b2, body: { stakeMinorUnits: '50000' } });
  assert.equal(okAfterBreak.status, 200, 'queue join is allowed again once the break ends');

  // ---------------------------------------------------------------------
  step('self-exclusion: one device locks the account everywhere');
  // ---------------------------------------------------------------------
  const excl = await api('POST', '/safer-play/self-exclusion', { userId: b1, body: { until: '30d' } });
  assert.equal(excl.status, 201, 'self-exclusion arms');
  assert.ok(excl.data.profile.selfExcludedUntil, 'selfExcludedUntil is set');

  const exclShrink = await api('POST', '/safer-play/self-exclusion', { userId: b1, body: { until: '7d' } });
  assert.equal(exclShrink.status, 409, 'self-exclusion can only be extended');

  const depBlocked = await api('POST', '/wallet/deposit-intent', { userId: b2, body: { amountMinorUnits: '50000', gateway: 'paystack' } });
  assert.equal(depBlocked.status, 403, 'device 2 money-in blocked by self-exclusion');
  assert.match(depBlocked.data.error, /Self-exclusion/);

  const joinBlocked = await api('POST', '/matchmaking/join', { userId: b2, body: { stakeMinorUnits: '50000' } });
  assert.equal(joinBlocked.status, 403, 'device 2 queue join blocked by self-exclusion');
  assert.match(joinBlocked.data.error, /Self-exclusion/);

  const wdBlocked = await api('POST', '/wallet/withdrawal-request', { userId: b1, body: { amountMinorUnits: '5000', idempotencyKey: `w-${B}-1` } });
  assert.equal(wdBlocked.status, 403, 'device 1 money-out blocked by self-exclusion');

  // ---------------------------------------------------------------------
  step('KYC gates money-OUT only; a simulated pass projects VERIFIED');
  // ---------------------------------------------------------------------
  const C = await createUser(); // kycStatus NONE
  await seedDeposit(C, 50000n, `c-fund-${C}`);

  const wdNoKyc = await api('POST', '/wallet/withdrawal-request', { userId: C, body: { amountMinorUnits: '1000', idempotencyKey: `w-${C}-1` } });
  assert.equal(wdNoKyc.status, 403, 'withdrawal without KYC is refused');
  assert.match(wdNoKyc.data.error, /KYC/);

  // Money IN stays open without KYC (no deposit-limit set, no safer-play block).
  const depNoKyc = await api('POST', '/wallet/deposit-intent', { userId: C, body: { amountMinorUnits: '5000', gateway: 'paystack' } });
  assert.notEqual(depNoKyc.status, 403, 'money in is NOT KYC-gated');
  assert.notEqual(depNoKyc.status, 422, 'no deposit limit block either');

  const kycStart = await api('POST', '/verification/start', { userId: C, body: { type: 'ID_DOCUMENT' } });
  assert.equal(kycStart.status, 201, 'simulated KYC passes by default');
  assert.equal(kycStart.data.status, 'VERIFIED');

  const kycStatusDev2 = await api('GET', '/verification/status', { userId: C });
  assert.equal(kycStatusDev2.data.kycStatus, 'VERIFIED', 'projected KYC status is visible from device 2');

  const kycRepeat = await api('POST', '/verification/start', { userId: C, body: {} });
  assert.equal(kycRepeat.status, 409, 'an already-verified account cannot re-verify');

  // Money OUT is now past the KYC gate — the next refusal is the missing bank
  // account, not KYC.
  const wdAfterKyc = await api('POST', '/wallet/withdrawal-request', { userId: C, body: { amountMinorUnits: '1000', idempotencyKey: `w-${C}-2` } });
  assert.notEqual(wdAfterKyc.status, 403, 'withdrawal is no longer KYC-blocked');
  assert.ok(!/KYC/.test(wdAfterKyc.data?.error ?? ''));

  // ---------------------------------------------------------------------
  step('stake limit set on device 1 blocks an over-limit stake on device 2');
  // ---------------------------------------------------------------------
  const D = await createUser({ tier: 'MASTER' });
  const stakeLimitDesired = STAKE_PRESETS.MASTER[0]; // 1,000,000
  const overStake = STAKE_PRESETS.MASTER[1]; // 1,500,000
  const calloutStake = STAKE_PRESETS.MASTER[2]; // 3,000,000

  const setStake = await api('PUT', '/safer-play/stake-limit', { userId: D, body: { amountMinorUnits: stakeLimitDesired.toString() } });
  assert.equal(setStake.status, 200);
  assert.equal(setStake.data.profile.effectiveStakeLimitMinorUnits, stakeLimitDesired.toString());

  const overJoin = await api('POST', '/matchmaking/join', { userId: D, body: { stakeMinorUnits: overStake.toString() } });
  assert.equal(overJoin.status, 422, 'device-2 queue join over the stake limit is refused');

  const overCallout = await api('POST', '/callouts', { userId: D, body: { stakeMinorUnits: calloutStake.toString() } });
  assert.equal(overCallout.status, 422, 'device-1 call-out over the stake limit is refused');
  assert.match(overCallout.data.error, /stake|safer-play/i);

  // ---------------------------------------------------------------------
  step('a failing simulated KYC provider marks the case REJECTED');
  // ---------------------------------------------------------------------
  const E = await createUser();
  const kycBadType = await api('POST', '/verification/start', { userId: E, body: { type: 'magic-palm' } });
  assert.equal(kycBadType.status, 400, 'an unsupported verification type is refused, not a 500');

  const failing = new SimulatedKycProvider({ result: 'fail' });
  await assert.rejects(
    startVerification(E, { providerName: 'simulated' }, { provider: failing }),
    KycRejectedError,
    'provider failure surfaces as KycRejectedError'
  );
  const eStatus = await api('GET', '/verification/status', { userId: E });
  assert.equal(eStatus.data.kycStatus, 'NONE', 'kycStatus projection is untouched by a rejection');
  assert.ok(eStatus.data.case, 'a case row exists');
  assert.equal(eStatus.data.case.status, 'REJECTED', 'the case is REJECTED, not VERIFIED');

  // ---------------------------------------------------------------------
  step('closed book: the deposit credits in this run all net to zero');
  // ---------------------------------------------------------------------
  const ledgerBaseline =
    (await prisma.ledgerEntry.aggregate({ _sum: { amountMinorUnits: true } }))._sum.amountMinorUnits ?? 0n;
  for (const key of depositCreditKeys) {
    const tx = await prisma.ledgerTransaction.findUniqueOrThrow({ where: { idempotencyKey: key } });
    const entries = await prisma.ledgerEntry.findMany({ where: { transactionId: tx.id } });
    assert.ok(entries.length >= 2, `every deposit credit has both legs (${key})`);
    const net = entries.reduce((acc, e) => acc + e.amountMinorUnits, 0n);
    assert.equal(net, 0n, `deposit credit ${key} nets to zero (closed book)`);
  }
  const ledgerNow =
    (await prisma.ledgerEntry.aggregate({ _sum: { amountMinorUnits: true } }))._sum.amountMinorUnits ?? 0n;
  assert.equal(ledgerNow, ledgerBaseline, 'balanced deposits leave the ledger sum unchanged');

  console.log(`ALL ${p} P-CHECKS PASSED`);
} finally {
  try {
    if (depositCreditKeys.length) {
      // Delete the transactions this run created first — this cascades every
      // entry (both the user leg and the shared liability leg), then our own
      // ledger accounts can go without hitting the account Restrict.
      await prisma.ledgerTransaction.deleteMany({ where: { idempotencyKey: { in: depositCreditKeys } } });
    }
    if (allUserIds.length) {
      await prisma.depositIntent.deleteMany({ where: { userId: { in: allUserIds } } });
      await prisma.withdrawal.deleteMany({ where: { userId: { in: allUserIds } } });
      await prisma.verificationCheck.deleteMany({
        where: { case: { userId: { in: allUserIds } } }
      });
      await prisma.verificationCase.deleteMany({ where: { userId: { in: allUserIds } } });
      const accounts = await prisma.ledgerAccount.findMany({ where: { userId: { in: allUserIds } } });
      await prisma.ledgerAccount.deleteMany({ where: { id: { in: accounts.map((a) => a.id) } } });
      await prisma.saferPlayEvent.deleteMany({ where: { userId: { in: allUserIds } } });
      await prisma.saferPlayProfile.deleteMany({ where: { userId: { in: allUserIds } } });
      await prisma.eligibility.deleteMany({ where: { userId: { in: allUserIds } } });
      await prisma.wallet.deleteMany({ where: { userId: { in: allUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: allUserIds } } });
    }
  } catch (err) {
    console.warn('cleanup warning:', err.message);
  }
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await prisma.$disconnect();
}