// Admin + RBAC + audit + disputes deep verification (real HTTP app + PG + Redis)
//
// Drives the real production admin wiring the way a second device would: every
// decision is role-per-mission and DB-backed, so a role grant/revoke binds
// across devices immediately. Also proves sanctioned ledger adjustments post
// balanced, idempotent entries and that denied attempts are as audited as
// successes. Exit gate: the full role matrix holds on the wire.
//
//   P1  no-role account: every admin endpoint is 403 and the denial is audited
//   P2  READ_ONLY_AUDITOR may list withdrawals + read the audit trail, but any
//       write is 403 (withdrawals.process, ledger.adjust, users.manage…)
//   P3  FINANCE approves/rejects the queue and posts a balanced CREDIT
//       adjustment; a replay returns the original txn (cross-device, idempotent)
//   P4  SUPPORT bans a player and attaches+decides a dispute
//   P5  RISK_COMPLIANCE approves a pending KYC case end to end; SUPPORT cannot
//   P6  SUPER_ADMIN grants GAME_OPERATIONS to the P1 account — it can now read
//       the audit trail from a fresh session; revoke re-binds immediately
//   P7  closed book: the posted adjustment nets to zero and replays exactly
//   P8  every action above left a matching row in the audit trail, DENIED ones
//       included
//
// Run:  NODE_ENV=test \
//       DATABASE_URL="postgresql://…@127.0.0.1:5432/draughts_arena" \
//       REDIS_URL="redis://:…@127.0.0.1:6379" \
//       node --env-file=.env scripts/verify/pr11-admin-rbac.mjs

import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import prisma from '../../src/utils/db.js';
import app from '../../src/app.js';
import { getJwtSecret } from '../../src/utils/jwtEnv.js';
import { ensureRoles } from '../../src/modules/rbac/service.js';
import { ensureUserAccounts } from '../../src/services/ledgerService.js';

if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
  throw new Error('DATABASE_URL and REDIS_URL must be set (run with the env overrides, see header)');
}

const JWT_SECRET = getJwtSecret();
const allUserIds = [];
const adjustmentKeys = [];
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

const token = (userId) => jwt.sign({ userId }, JWT_SECRET, { expiresIn: '10m' });

// Every admin POST requires an Idempotency-Key; keep keys unique so ledger
// replay assertions exercise the business reference key, not the HTTP cache.
let opSeq = 0;
const api = async (method, path, { userId, body } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token(userId)}`,
      ...(method === 'POST' ? { 'idempotency-key': `pr11-${Date.now()}-${++opSeq}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
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

const createUser = async () => {
  const id = `pr11-${randomUUID()}`;
  await prisma.user.create({
    data: {
      id,
      email: `${id}@harness.local`,
      passwordHash: 'x',
      tier: 'AMATEUR',
      countryCode: 'NG',
      kycStatus: 'VERIFIED',
      wallet: { create: { currency: 'NGN' } },
      eligibility: {
        create: { countryCode: 'NG', countryAllowed: true, ageVerified: true }
      }
    }
  });
  await ensureUserAccounts(prisma, id);
  allUserIds.push(id);
  return id;
};

const grantRole = async (userId, roleName) => {
  const role = await prisma.adminRole.findUniqueOrThrow({ where: { name: roleName } });
  await prisma.adminRoleAssignment.upsert({
    where: { userId_roleId: { userId, roleId: role.id } },
    create: { userId, roleId: role.id },
    update: {}
  });
};

let p = 0;
const step = (name) => {
  p += 1;
  console.log(`P${p} ${name}`);
};

try {
  await ready();
  await ensureRoles({ dbp: prisma });

  const httpServer = http.createServer(app);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  server = httpServer;
  base = `http://127.0.0.1:${httpServer.address().port}/api/v1`;
  console.log(`harness server on ${base}`);

  // Wait for the app to attach its global error handler and listen.
  await new Promise((r) => setTimeout(r, 300));

  const boss = await createUser();
  const noRole = await createUser();
  const auditor = await createUser();
  const finance = await createUser();
  const support = await createUser();
  const compliance = await createUser();
  const player = await createUser();
  const player2 = await createUser();

  await grantRole(boss, 'SUPER_ADMIN');
  await grantRole(auditor, 'READ_ONLY_AUDITOR');
  await grantRole(finance, 'FINANCE');
  await grantRole(support, 'SUPPORT');
  await grantRole(compliance, 'RISK_COMPLIANCE');

  // -----------------------------------------------------------------------
  step('P1: a no-role account is 403 everywhere and the denial is audited');
  // -----------------------------------------------------------------------
  for (const path of [
    '/admin/withdrawals',
    '/admin/roles',
    '/admin/kyc/cases',
    '/admin/disputes',
    '/admin/risk-events'
  ]) {
    const res = await api('GET', path, { userId: noRole });
    assert.equal(res.status, 403, `${path} must 403 for a no-role account`);
    assert.match(res.data.error, /Insufficient admin permission/);
  }
  const writeToo = await api('POST', '/admin/ledger/adjustments', {
    userId: noRole,
    body: { userId: player, amountMinorUnits: '1000', direction: 'CREDIT', reference: 'p1-adjust' }
  });
  assert.equal(writeToo.status, 403, 'money writes need a role too');

  // -----------------------------------------------------------------------
  step('P2: READ_ONLY_AUDITOR reads, any write is 403');
  // -----------------------------------------------------------------------
  const auditorOut = await api('GET', '/admin/withdrawals', { userId: auditor });
  assert.equal(auditorOut.status, 200, 'auditor may list withdrawals');
  const trailRead = await api('GET', '/admin/audit/logs', { userId: auditor });
  assert.equal(trailRead.status, 200, 'auditor may read the audit trail');
  assert.ok(trailRead.data.logs.some((l) => l.action === 'permission.denied:withdrawals.read'), 'the P1 denial is visible');

  const approveBlocked = await api('POST', '/admin/withdrawals/x/approve', { userId: auditor });
  assert.equal(approveBlocked.status, 403, 'auditor cannot approve withdrawals');
  const banBlocked = await api('PATCH', `/admin/users/${player}/ban`, { userId: auditor });
  assert.equal(banBlocked.status, 403, 'auditor cannot manage accounts');
  const adjustBlocked = await api('POST', '/admin/ledger/adjustments', {
    userId: auditor,
    body: { userId: player, amountMinorUnits: '1000', direction: 'CREDIT', reference: 'aud-adjust' }
  });
  assert.equal(adjustBlocked.status, 403, 'auditor cannot touch the ledger');

  // -----------------------------------------------------------------------
  step('P3: FINANCE runs the queue and posts a balanced credit (idempotent)');
  // -----------------------------------------------------------------------
  const approveMissing = await api('POST', '/admin/withdrawals/does-not-exist/approve', { userId: finance });
  assert.equal(approveMissing.status, 404, 'FINANCE passes the gate and reaches the service');
  const rejectMissing = await api('POST', '/admin/withdrawals/does-not-exist/reject', { userId: finance });
  assert.equal(rejectMissing.status, 404, 'reject passes the gate too');

  const ref = `harness-adjust-${randomUUID()}`;
  const adjust = await api('POST', '/admin/ledger/adjustments', {
    userId: finance,
    body: { userId: player2, amountMinorUnits: '100000', direction: 'CREDIT', reason: 'harness credit', reference: ref }
  });
  assert.equal(adjust.status, 201, 'FINANCE posts an adjustment');
  assert.equal(adjust.data.adjustment.direction, 'CREDIT');
  assert.equal(adjust.data.adjustment.available, '100000');
  adjustmentKeys.push(`adjustment:${ref}`);

  const replay = await api('POST', '/admin/ledger/adjustments', {
    userId: finance,
    body: { userId: player2, amountMinorUnits: '100000', direction: 'CREDIT', reason: 'harness credit', reference: ref }
  });
  assert.equal(replay.status, 201, 'replay is accepted, not duplicated');
  assert.equal(replay.data.adjustment.transactionId, adjust.data.adjustment.transactionId, 'same transaction returns on replay');

  const overdraw = await api('POST', '/admin/ledger/adjustments', {
    userId: finance,
    body: { userId: player, amountMinorUnits: '99999999999999', direction: 'DEBIT', reason: 'overdraw', reference: `od-${randomUUID()}` }
  });
  assert.equal(overdraw.status, 422, 'an overdraft debit is refused');

  // -----------------------------------------------------------------------
  step('P4: SUPPORT bans a player (binds on a fresh session) and runs a dispute');
  // -----------------------------------------------------------------------
  const ban = await api('PATCH', `/admin/users/${player2}/ban`, { userId: support });
  assert.equal(ban.status, 200, 'SUPPORT bans the player');
  assert.equal(ban.data.message, 'Account suspended');

  const freshSession = await api('GET', '/wallet/balance', { userId: player2 });
  assert.equal(freshSession.status, 401, 'a fresh session on the banned account is refused');

  const unban = await api('PATCH', `/admin/users/${player2}/unban`, { userId: support });
  assert.equal(unban.status, 200, 'SUPPORT reinstates the player');

  const match = await prisma.match.create({
    data: {
      playerLightId: player2,
      playerDarkId: player,
      tier: 'AMATEUR',
      stakeMinorUnits: 10000n
    }
  });
  const dispute = await prisma.disputeCase.create({
    data: { matchId: match.id, raisedBy: player, status: 'OPEN', reason: 'Result disputed' }
  });
  allUserIds.push(`__match__${match.id}`);

  const evidence = await api('POST', `/admin/disputes/${dispute.id}/evidence`, {
    userId: support,
    body: { type: 'GAME_LOG', url: 'https://cdn.test/game.json' }
  });
  assert.equal(evidence.status, 201, 'SUPPORT attaches evidence');
  const decide = await api('POST', `/admin/disputes/${dispute.id}/decision`, {
    userId: support,
    body: { status: 'RESOLVED', resolution: 'Confirmed; no refund.' }
  });
  assert.equal(decide.status, 200, 'SUPPORT decides the dispute');
  assert.equal(decide.data.disputeCase.status, 'RESOLVED');
  const decideAgain = await api('POST', `/admin/disputes/${dispute.id}/decision`, {
    userId: support,
    body: { status: 'RESOLVED', resolution: 'Already decided.' }
  });
  assert.equal(decideAgain.status, 409, 'a decided dispute cannot be re-decided');

  // -----------------------------------------------------------------------
  step('P5: RISK_COMPLIANCE approves KYC end to end; SUPPORT stays out');
  // -----------------------------------------------------------------------
  const supportKyc = await api('POST', '/admin/kyc/cases/x/decision', {
    userId: support,
    body: { decision: 'APPROVE' }
  });
  assert.equal(supportKyc.status, 403, 'SUPPORT has no KYC review right');

  const kycCase = await prisma.verificationCase.create({
    data: {
      userId: player,
      status: 'UNDER_REVIEW',
      provider: 'simulated',
      checks: { create: { type: 'ID_DOCUMENT', status: 'PENDING' } }
    }
  });
  allUserIds.push(`__case__${kycCase.id}`);

  const approve = await api('POST', `/admin/kyc/cases/${kycCase.id}/decision`, {
    userId: compliance,
    body: { decision: 'APPROVE', note: 'harness pass' }
  });
  assert.equal(approve.status, 200, 'RISK_COMPLIANCE approves the case');
  assert.equal(approve.data.verificationCase.status, 'VERIFIED');
  const kycUser = await prisma.user.findUnique({ where: { id: player } });
  assert.equal(kycUser.kycStatus, 'VERIFIED', 'the pass projects onto the user');

  // -----------------------------------------------------------------------
  step('P6: a grant binds to a fresh session instantly; so does the revoke');
  // -----------------------------------------------------------------------
  const assign = await api('POST', '/admin/roles/assign', {
    userId: boss,
    body: { userId: noRole, roleName: 'GAME_OPERATIONS' }
  });
  assert.equal(assign.status, 201, 'SUPER_ADMIN assigns on the wire');

  const grantedRead = await api('GET', '/admin/audit/logs', { userId: noRole });
  assert.equal(grantedRead.status, 200, 'newly granted read is active for a fresh session');

  const roleView = await api('GET', '/admin/roles', { userId: boss });
  assert.equal(roleView.status, 200);
  assert.equal(roleView.data.roles.length, 6, 'the six roles are exposed');
  assert.ok(roleView.data.roles.find((r) => r.name === 'SUPER_ADMIN').permissions.includes('roles.admin'), 'role grants stay SUPER_ADMIN-only');

  await api('POST', '/admin/roles/revoke', { userId: boss, body: { userId: noRole, roleName: 'GAME_OPERATIONS' } });
  const revokedRead = await api('GET', '/admin/audit/logs', { userId: noRole });
  assert.equal(revokedRead.status, 403, 'the revoke binds immediately across sessions');

  // -----------------------------------------------------------------------
  step('P7: the adjustment left the books closed and identical on replay');
  // -----------------------------------------------------------------------
  for (const key of adjustmentKeys) {
    const txn = await prisma.ledgerTransaction.findUniqueOrThrow({ where: { idempotencyKey: key } });
    const entries = await prisma.ledgerEntry.findMany({ where: { transactionId: txn.id } });
    assert.equal(entries.reduce((sum, e) => sum + e.amountMinorUnits, 0n), 0n, `${key} nets to zero`);
  }
  const ledgerNet =
    (await prisma.ledgerEntry.aggregate({ _sum: { amountMinorUnits: true } }))._sum.amountMinorUnits ?? 0n;
  assert.equal(ledgerNet, 0n, 'posting + replay left the whole ledger netting zero');

  // -----------------------------------------------------------------------
  step('P8: the audit trail carries successes AND denials');
  // -----------------------------------------------------------------------
  const logs = await api('GET', '/admin/audit/logs?limit=100', { userId: auditor });
  assert.equal(logs.status, 200);
  const actions = logs.data.logs.map((l) => l.action);
  for (const expected of [
    'permission.denied:withdrawals.read',
    'role.assign',
    'role.revoke',
    'ledger.adjustment',
    'user.ban',
    'user.unban',
    'verification.approve',
    'dispute.evidence',
    'dispute.decide'
  ]) {
    assert.ok(actions.includes(expected), `audit trail contains ${expected}`);
  }
  assert.ok(logs.data.logs.every((l) => ['SUCCESS', 'DENIED'].includes(l.outcome)), 'only canonical outcomes exist');

  console.log(`ALL ${p} P-CHECKS PASSED`);
} finally {
  try {
    if (adjustmentKeys.length) {
      const txs = await prisma.ledgerTransaction.findMany({ where: { idempotencyKey: { in: adjustmentKeys } } });
      if (txs.length) {
        await prisma.ledgerEntry.deleteMany({ where: { transactionId: { in: txs.map((t) => t.id) } } });
        await prisma.ledgerTransaction.deleteMany({ where: { id: { in: txs.map((t) => t.id) } } });
      }
    }
    if (allUserIds.length) {
      const realUsers = allUserIds.filter((id) => !id.startsWith('__'));
      const matchIds = allUserIds.filter((id) => id.startsWith('__match__')).map((id) => id.slice(9));
      const caseIds = allUserIds.filter((id) => id.startsWith('__case__')).map((id) => id.slice(8));

      await prisma.idempotencyRecord.deleteMany({ where: { key: { contains: 'pr11-' } } });
      await prisma.adminAuditLog.deleteMany({
        where: { OR: [{ adminId: { in: realUsers } }, { targetType: 'user', targetId: { in: realUsers } }] }
      });
      await prisma.verificationCheck.deleteMany({ where: { caseId: { in: caseIds } } });
      await prisma.verificationCase.deleteMany({ where: { id: { in: caseIds } } });
      await prisma.disputeCase.deleteMany({ where: { matchId: { in: matchIds } } });
      await prisma.match.deleteMany({ where: { id: { in: matchIds } } });
      const accounts = await prisma.ledgerAccount.findMany({ where: { userId: { in: realUsers } } });
      await prisma.ledgerAccount.deleteMany({ where: { id: { in: accounts.map((a) => a.id) } } });
      await prisma.saferPlayEvent.deleteMany({ where: { userId: { in: realUsers } } });
      await prisma.saferPlayProfile.deleteMany({ where: { userId: { in: realUsers } } });
      await prisma.eligibility.deleteMany({ where: { userId: { in: realUsers } } });
      await prisma.wallet.deleteMany({ where: { userId: { in: realUsers } } });
      await prisma.user.deleteMany({ where: { id: { in: realUsers } } });
    }
  } catch (err) {
    console.warn('cleanup warning:', err.message);
  }
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await prisma.$disconnect();
}