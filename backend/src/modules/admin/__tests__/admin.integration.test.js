// Real-PostgreSQL + Redis integration test for the admin API, RBAC and audit
// trail. Run with:
//   DATABASE_URL=... REDIS_URL=... RUN_DB_INTEGRATION=1 RUN_REDIS_INTEGRATION=1 \
//   node --experimental-vm-modules node_modules/jest/bin/jest.js \
//     --runInBand --forceExit --no-coverage src/modules/admin/__tests__/admin.integration.test.js
import { describe, it, expect, afterAll, beforeAll, jest } from '@jest/globals';
import 'dotenv/config';
import express from 'express';
import request from 'supertest';
import prisma from '../../../utils/db.js';
import { ensureRoles } from '../../rbac/service.js';
import { AuthService } from '../../auth/service.js';
import { adminRouter } from '../controller.js';

const describeIntegration =
  process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

const app = express();
app.use(express.json());
app.use('/api/v1/admin', adminRouter);
app.use((err, _req, res, _next) => {
  res.status(err.status || err.statusCode || 500).json({ error: err.message || 'Internal server error' });
});

describeIntegration('Admin v2 (real PostgreSQL + Redis)', () => {
  const createdUsers = [];
  const createdWalletIds = [];
  const createdMatchIds = [];
  const adjustmentTxIds = [];

  const createUser = async (email) => {
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: 'x',
        kycStatus: 'NONE',
        countryCode: 'NG'
      }
    });
    createdUsers.push(user.id);
    return user;
  };

  const giveRole = async (userId, roleName, assignedBy = null) => {
    const role = await prisma.adminRole.findUnique({ where: { name: roleName } });
    return prisma.adminRoleAssignment.create({
      data: { userId, roleId: role.id, assignedBy }
    });
  };

  const tokenFor = async (id) => {
    const { accessToken } = await AuthService.issueTokens(id);
    return accessToken;
  };

  let auditor;
  let finance;
  let risk;
  let support;
  let superAdmin;
  let player;
  let player2;

  beforeAll(async () => {
    await ensureRoles({ dbp: prisma });
    auditor = await createUser(`aud-${Date.now()}@admin.local`);
    finance = await createUser(`fin-${Date.now()}@admin.local`);
    risk = await createUser(`risk-${Date.now()}@admin.local`);
    support = await createUser(`sup-${Date.now()}@admin.local`);
    superAdmin = await createUser(`su-${Date.now()}@admin.local`);
    player = await createUser(`pl-${Date.now()}@player.local`);
    player2 = await createUser(`plb-${Date.now()}@player.local`);
    await giveRole(auditor.id, 'READ_ONLY_AUDITOR', superAdmin.id);
    await giveRole(finance.id, 'FINANCE', superAdmin.id);
    await giveRole(risk.id, 'RISK_COMPLIANCE', superAdmin.id);
    await giveRole(support.id, 'SUPPORT', superAdmin.id);
    await giveRole(superAdmin.id, 'SUPER_ADMIN', superAdmin.id);
  });

  afterAll(async () => {
    const userIds = [...createdUsers];
    const walletIds = createdWalletIds;

    await prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: walletIds } } });
    await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.adminAuditLog.deleteMany({
      where: {
        OR: [
          { adminId: { in: userIds } },
          { targetType: 'user', targetId: { in: userIds } }
        ]
      }
    });
    await prisma.adminRoleAssignment.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.saferPlayEvent.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.saferPlayProfile.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.verificationCheck.deleteMany({ where: { case: { userId: { in: userIds } } } });
    await prisma.verificationCase.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.ledgerEntry.deleteMany({ where: { transactionId: { in: adjustmentTxIds } } });
    await prisma.ledgerTransaction.deleteMany({ where: { id: { in: adjustmentTxIds } } });
    const accounts = await prisma.ledgerAccount.findMany({ where: { userId: { in: userIds } } });
    const accountIds = accounts.map((a) => a.id);
    await prisma.ledgerEntry.deleteMany({ where: { accountId: { in: accountIds } } });
    await prisma.ledgerAccount.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.wallet.deleteMany({ where: { id: { in: walletIds } } });
    await prisma.riskEvent.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.riskCase.deleteMany({ where: { subjectId: { in: userIds } } });
    await prisma.match.deleteMany({ where: { id: { in: createdMatchIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  const auth = (token) => ({ Authorization: `Bearer ${token}` });

  it('denies a plain admin session without any role', async () => {
    const token = await tokenFor(player.id);
    const res = await request(app).get('/api/v1/admin/withdrawals').set(auth(token));
    expect(res.status).toBe(403);
  });

  it('keeps READ_ONLY_AUDITOR read-only on the wire', async () => {
    const token = await tokenFor(auditor.id);
    const list = await request(app).get('/api/v1/admin/withdrawals').set(auth(token));
    expect(list.status).toBe(200);
    const approve = await request(app)
      .post('/api/v1/admin/withdrawals/does-not-exist/approve')
      .set(auth(token));
    expect(approve.status).toBe(403);
    const adjust = await request(app)
      .post('/api/v1/admin/ledger/adjustments')
      .set(auth(token))
      .send({ userId: player.id, amountMinorUnits: '1000', direction: 'CREDIT', reference: 'aud-adj' });
    expect(adjust.status).toBe(403);
  });

  it('lets FINANCE read the queue and approves/rejects withdrawals', async () => {
    const token = await tokenFor(finance.id);
    const list = await request(app).get('/api/v1/admin/withdrawals').set(auth(token));
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.withdrawals)).toBe(true);

    const missing = await request(app)
      .post('/api/v1/admin/withdrawals/does-not-exist/approve')
      .set(auth(token));
    expect(missing.status).toBe(404);

    const noReason = await request(app)
      .post('/api/v1/admin/withdrawals/does-not-exist/reject')
      .set(auth(token));
    expect(noReason.status).toBe(404);
  });

  it('posts a balanced CREDIT adjustment and replays it idempotently', async () => {
    const token = await tokenFor(finance.id);
    const wallet = await prisma.wallet.create({ data: { userId: player2.id } });
    createdWalletIds.push(wallet.id);

    const body = {
      userId: player2.id,
      amountMinorUnits: '250000',
      direction: 'CREDIT',
      reason: 'courtesy credit',
      reference: `itg-adjust-${Date.now()}`
    };

    const first = await request(app)
      .post('/api/v1/admin/ledger/adjustments')
      .set(auth(token))
      .send(body);
    expect(first.status).toBe(201);
    expect(first.body.adjustment.direction).toBe('CREDIT');
    expect(first.body.adjustment.available).toBe('250000');
    adjustmentTxIds.push(first.body.adjustment.transactionId);

    const second = await request(app)
      .post('/api/v1/admin/ledger/adjustments')
      .set(auth(token))
      .send(body);
    expect(second.status).toBe(201);
    expect(second.body.adjustment.transactionId).toBe(first.body.adjustment.transactionId);

    const entries = await prisma.ledgerEntry.findMany({
      where: { transactionId: first.body.adjustment.transactionId }
    });
    expect(entries.reduce((sum, e) => sum + e.amountMinorUnits, 0n)).toBe(0n);
  });

  it('refuses a DEBIT adjustment that would overdraw the player', async () => {
    const token = await tokenFor(finance.id);
    const res = await request(app)
      .post('/api/v1/admin/ledger/adjustments')
      .set(auth(token))
      .send({
        userId: player.id,
        amountMinorUnits: '999999999999',
        direction: 'DEBIT',
        reference: `itg-overdraw-${Date.now()}`
      });
    expect(res.status).toBe(422);
  });

  it('keeps role grants exclusive to SUPER_ADMIN', async () => {
    const token = await tokenFor(finance.id);
    const res = await request(app)
      .post('/api/v1/admin/roles/assign')
      .set(auth(token))
      .send({ userId: player.id, roleName: 'SUPPORT' });
    expect(res.status).toBe(403);
  });

  it('grants a role and revokes it with immediate effect (DB-backed binding)', async () => {
    const adminToken = await tokenFor(superAdmin.id);
    const assign = await request(app)
      .post('/api/v1/admin/roles/assign')
      .set(auth(adminToken))
      .send({ userId: player.id, roleName: 'GAME_OPERATIONS' });
    expect(assign.status).toBe(201);

    const playerToken = await tokenFor(player.id);
    const read = await request(app).get('/api/v1/admin/audit/logs').set(auth(playerToken));
    expect(read.status).toBe(200);

    const revoke = await request(app)
      .post('/api/v1/admin/roles/revoke')
      .set(auth(adminToken))
      .send({ userId: player.id, roleName: 'GAME_OPERATIONS' });
    expect(revoke.status).toBe(200);
    expect(revoke.body.revoked).toBe(1);

    const denied = await request(app).get('/api/v1/admin/audit/logs').set(auth(playerToken));
    expect(denied.status).toBe(403);
  });

  it('has SUPPORT ban a user and disconnect their sessions', async () => {
    const token = await tokenFor(support.id);
    const res = await request(app)
      .patch(`/admin/users/${player2.id}/ban`)
      .set(auth(token));
    expect(res.status).toBe(200);
    const banned = await prisma.user.findUnique({ where: { id: player2.id } });
    expect(banned.isBanned).toBe(true);

    const unban = await request(app)
      .patch(`/admin/users/${player2.id}/unban`)
      .set(auth(token));
    expect(unban.status).toBe(200);
  });

  it('lets RISK_COMPLIANCE approve a pending KYC case end to end', async () => {
    const vc = await prisma.verificationCase.create({
      data: {
        userId: player.id,
        status: 'UNDER_REVIEW',
        provider: 'simulated',
        checks: {
          create: { type: 'ID_DOCUMENT', status: 'PENDING' }
        }
      }
    });
    const token = await tokenFor(risk.id);
    const res = await request(app)
      .post(`/admin/verification-cases/${vc.id}/approve`)
      .set(auth(token))
      .send({ note: 'integration pass' });
    expect(res.status).toBe(200);
    expect(res.body.verificationCase.status).toBe('VERIFIED');

    const user = await prisma.user.findUnique({ where: { id: player.id } });
    expect(user.kycStatus).toBe('VERIFIED');
  });

  it('has SUPPORT attach evidence to and decide a dispute', async () => {
    const match = await prisma.match.create({
      data: {
        playerLightId: player.id,
        playerDarkId: player2.id,
        tier: 'AMATEUR',
        stakeMinorUnits: 10000n
      }
    });
    const dispute = await prisma.disputeCase.create({
      data: { matchId: match.id, raisedBy: player.id, status: 'OPEN', reason: 'Result disputed' }
    });
    createdMatchIds.push(match.id);
    const token = await tokenFor(support.id);

    const evidence = await request(app)
      .post(`/admin/disputes/${dispute.id}/evidence`)
      .set(auth(token))
      .send({ type: 'GAME_LOG', url: 'https://cdn.test/gamelog.json' });
    expect(evidence.status).toBe(201);

    const decide = await request(app)
      .post(`/admin/disputes/${dispute.id}/decide`)
      .set(auth(token))
      .send({ status: 'RESOLVED', resolution: 'Reader confirms the result, no refund.' });
    expect(decide.status).toBe(200);
    expect(decide.body.disputeCase.status).toBe('RESOLVED');

    const again = await request(app)
      .post(`/admin/disputes/${dispute.id}/decide`)
      .set(auth(token))
      .send({ status: 'RESOLVED', resolution: 'Already resolved.' });
    expect(again.status).toBe(409);
  });

  it('has SUPPORT lift a safer-play timeout and FINANCE read the audit trail', async () => {
    await prisma.saferPlayProfile.upsert({
      where: { userId: player.id },
      create: { userId: player.id, timeoutUntil: new Date('2099-01-01T00:00:00Z') },
      update: { timeoutUntil: new Date('2099-01-01T00:00:00Z') }
    });

    const token = await tokenFor(support.id);
    const res = await request(app)
      .post(`/admin/safer-play/${player.id}/clear-timeout`)
      .set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.lifted).toBe(true);

    const auditToken = await tokenFor(finance.id);
    const logs = await request(app).get('/api/v1/admin/audit/logs').set(auth(auditToken));
    expect(logs.status).toBe(200);
    const actions = logs.body.logs.map((l) => l.action);
    expect(actions).toContain('safer-play.clear-timeout');
    expect(actions).toContain('ledger.adjustment');
    expect(actions).toContain('role.assign');
  });
});