import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import 'dotenv/config';
import express from 'express';
import request from 'supertest';
import prisma from '../../../utils/db.js';
import { ensureRoles, assignRole, revokeRole, RoleAssignmentError } from '../../rbac/service.js';
import { AuthService } from '../../auth/service.js';
import { adminRouter } from '../controller.js';
import { postAdjustment, InvalidAmountError, InsufficientFundsError } from '../../../services/ledgerService.js';
import { applyAdminSaferPlayRestriction } from '../../saferPlay/service.js';
import { generateVerificationDocumentAccess } from '../../verification/service.js';

const app = express();
app.use(express.json());
app.use('/api/v1/admin', adminRouter);
app.use((err, _req, res, _next) => {
  res.status(err.status || err.statusCode || 500).json({ error: err.message || 'Internal server error' });
});

const describeIntegration =
  process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

describeIntegration('Focused Security Verification: 3 Core Pillars', () => {
  let superAdminToken;
  let superAdminUser;
  let auditorToken;
  let auditorUser;
  let testPlayer;

  beforeAll(async () => {
    await ensureRoles();

    // Create Super Admin
    superAdminUser = await prisma.user.create({
      data: {
        email: `sec-super-${Date.now()}@test.internal`,
        passwordHash: 'hash-placeholder',
        kycStatus: 'VERIFIED'
      }
    });
    await assignRole(superAdminUser.id, 'SUPER_ADMIN');
    const saSession = await AuthService.issueTokens(superAdminUser.id);
    superAdminToken = saSession.accessToken;

    // Create Auditor (READ_ONLY_AUDITOR)
    auditorUser = await prisma.user.create({
      data: {
        email: `sec-auditor-${Date.now()}@test.internal`,
        passwordHash: 'hash-placeholder',
        kycStatus: 'VERIFIED'
      }
    });
    await assignRole(auditorUser.id, 'READ_ONLY_AUDITOR');
    const audSession = await AuthService.issueTokens(auditorUser.id);
    auditorToken = audSession.accessToken;

    // Create Player
    testPlayer = await prisma.user.create({
      data: {
        email: `sec-player-${Date.now()}@test.internal`,
        passwordHash: 'hash-placeholder',
        kycStatus: 'PENDING'
      }
    });
  });

  afterAll(async () => {
    if (testPlayer) {
      await prisma.ledgerEntry.deleteMany({ where: { account: { userId: testPlayer.id } } });
      await prisma.ledgerAccount.deleteMany({ where: { userId: testPlayer.id } });
      await prisma.wallet.deleteMany({ where: { userId: testPlayer.id } });
      await prisma.saferPlayProfile.deleteMany({ where: { userId: testPlayer.id } });
      await prisma.saferPlayEvent.deleteMany({ where: { userId: testPlayer.id } });
      await prisma.user.deleteMany({ where: { id: testPlayer.id } });
    }
    if (auditorUser) {
      await prisma.adminAuditLog.deleteMany({ where: { adminId: auditorUser.id } });
      await prisma.adminRoleAssignment.deleteMany({ where: { userId: auditorUser.id } });
      await prisma.user.deleteMany({ where: { id: auditorUser.id } });
    }
    if (superAdminUser) {
      await prisma.adminAuditLog.deleteMany({ where: { adminId: superAdminUser.id } });
      await prisma.adminRoleAssignment.deleteMany({ where: { userId: superAdminUser.id } });
      await prisma.user.deleteMany({ where: { id: superAdminUser.id } });
    }
    await prisma.$disconnect();
  });

  // =========================================================================
  // PILLAR 1: AUTHENTICATION, RBAC & BOUNDARY SEGREGATION
  // =========================================================================
  describe('Pillar 1: Admin Authentication & RBAC Boundary Security', () => {
    it('rejects unauthenticated requests to protected endpoints', async () => {
      const res = await request(app).get('/api/v1/admin/dashboard/summary');
      expect([401, 403]).toContain(res.status);
    });

    it('strictly forbids READ_ONLY_AUDITOR from performing mutations', async () => {
      // 1. Attempt ledger adjustment
      const resAdj = await request(app)
        .post('/api/v1/admin/ledger/adjustments')
        .set('Authorization', `Bearer ${auditorToken}`)
        .send({
          userId: testPlayer.id,
          amountMinorUnits: '1000',
          direction: 'CREDIT',
          reference: 'auditor-attack-ref'
        });
      expect(resAdj.status).toBe(403);

      // 2. Attempt role grant
      const resRole = await request(app)
        .post('/api/v1/admin/roles/assign')
        .set('Authorization', `Bearer ${auditorToken}`)
        .send({ userId: auditorUser.id, roleName: 'SUPER_ADMIN' });
      expect(resRole.status).toBe(403);

      // 3. Attempt user ban
      const resBan = await request(app)
        .patch(`/api/v1/admin/users/${testPlayer.id}/ban`)
        .set('Authorization', `Bearer ${auditorToken}`);
      expect(resBan.status).toBe(403);

      // Verify that denied attempt was recorded in the audit trail
      const deniedLog = await prisma.adminAuditLog.findFirst({
        where: {
          adminId: auditorUser.id,
          outcome: 'DENIED'
        }
      });
      expect(deniedLog).toBeTruthy();
    });

    it('prevents accidental admin lockout: blocks revoking the last SUPER_ADMIN', async () => {
      // Create a temporary solitary super admin
      const tempAdmin = await prisma.user.create({
        data: { email: `last-admin-${Date.now()}@test.internal`, passwordHash: 'hash' }
      });
      await assignRole(tempAdmin.id, 'SUPER_ADMIN');

      // Temporarily remove all other super admin assignments so tempAdmin is solitary
      const otherAdmins = await prisma.adminRoleAssignment.findMany({
        where: { role: { name: 'SUPER_ADMIN' }, userId: { not: tempAdmin.id } }
      });
      await prisma.adminRoleAssignment.deleteMany({
        where: { role: { name: 'SUPER_ADMIN' }, userId: { not: tempAdmin.id } }
      });

      // Attempt to revoke the last super admin -> must fail!
      await expect(revokeRole(tempAdmin.id, 'SUPER_ADMIN')).rejects.toThrow(
        /Cannot revoke the last remaining SUPER_ADMIN/
      );

      // Restore other admins
      for (const a of otherAdmins) {
        await prisma.adminRoleAssignment.create({
          data: { userId: a.userId, roleId: a.roleId, assignedBy: a.assignedBy }
        });
      }
      await prisma.adminRoleAssignment.deleteMany({ where: { userId: tempAdmin.id } });
      await prisma.user.delete({ where: { id: tempAdmin.id } });
    });
  });

  // =========================================================================
  // PILLAR 2: FINANCIAL INTEGRITY & DOUBLE-ENTRY LEDGER PROTECTION
  // =========================================================================
  describe('Pillar 2: Financial Integrity & Ledger Protection', () => {
    it('rejects negative or zero amounts in ledger adjustments', async () => {
      // 1. Direct service call with negative BigInt
      await prisma.$transaction(async (tx) => {
        await expect(
          postAdjustment(tx, {
            userId: testPlayer.id,
            amountMinorUnits: -5000n,
            direction: 'CREDIT',
            reference: `neg-ref-${Date.now()}`
          })
        ).rejects.toThrow(/positive/i);
      });

      // 2. Controller endpoint call with negative string
      const resNeg = await request(app)
        .post('/api/v1/admin/ledger/adjustments')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          userId: testPlayer.id,
          amountMinorUnits: '-5000',
          direction: 'CREDIT',
          reference: `neg-ctrl-${Date.now()}`
        });
      expect(resNeg.status).toBe(400);

      // 3. Controller endpoint call with zero string
      const resZero = await request(app)
        .post('/api/v1/admin/ledger/adjustments')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          userId: testPlayer.id,
          amountMinorUnits: '0',
          direction: 'CREDIT',
          reference: `zero-ctrl-${Date.now()}`
        });
      expect(resZero.status).toBe(400);
    });

    it('enforces anti-overdraw invariant on DEBIT adjustments', async () => {
      const resDebit = await request(app)
        .post('/api/v1/admin/ledger/adjustments')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          userId: testPlayer.id,
          amountMinorUnits: '9999999999', // player has 0 balance
          direction: 'DEBIT',
          reference: `overdraw-ref-${Date.now()}`
        });
      expect([409, 422]).toContain(resDebit.status);
    });

    it('guarantees idempotency and zero-sum balance invariant across transactions', async () => {
      const uniqueRef = `idem-test-${Date.now()}`;
      const payload = {
        userId: testPlayer.id,
        amountMinorUnits: '25000', // 250 NGN
        direction: 'CREDIT',
        reference: uniqueRef
      };

      const res1 = await request(app)
        .post('/api/v1/admin/ledger/adjustments')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send(payload);
      expect(res1.status).toBe(201);
      const txId1 = res1.body.adjustment.transactionId;

      // Replay identical request
      const res2 = await request(app)
        .post('/api/v1/admin/ledger/adjustments')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send(payload);
      expect([200, 201]).toContain(res2.status);
      expect(res2.body.adjustment.transactionId).toBe(txId1);

      // Verify double-entry balance in database: sum of entries must equal exactly 0n
      const entries = await prisma.ledgerEntry.findMany({
        where: { transactionId: txId1 }
      });
      const netSum = entries.reduce((acc, e) => acc + BigInt(e.amountMinorUnits), 0n);
      expect(netSum).toBe(0n);
    });
  });

  // =========================================================================
  // PILLAR 3: COMPLIANCE, DOCUMENT SECURITY & SAFER PLAY INVARIANTS
  // =========================================================================
  describe('Pillar 3: Compliance & Safer Play Invariants', () => {
    it('generates ephemeral HMAC signed access tokens without leaking raw storage secrets or PII', async () => {
      const caseRow = await prisma.verificationCase.create({
        data: {
          userId: testPlayer.id,
          status: 'PENDING',
          provider: 'DOJAH'
        }
      });

      const res = await generateVerificationDocumentAccess(caseRow.id, {
        adminId: superAdminUser.id
      });

      expect(res.access).toBeDefined();
      expect(res.access.signedToken).toMatch(/^kyc_sig_[a-f0-9]{32}$/);
      expect(res.access.expiresInSeconds).toBe(120);
      expect(res.access.watermark).toContain(superAdminUser.id);
      expect(JSON.stringify(res.access)).not.toContain('s3://');
      expect(JSON.stringify(res.access)).not.toContain('http://');

      await prisma.verificationCase.delete({ where: { id: caseRow.id } });
    });

    it('blocks shortening active timeouts (extend-only invariant)', async () => {
      const now = new Date();
      // Set 48h timeout
      const longTimeout = new Date(now.getTime() + 48 * 3600 * 1000).toISOString();
      await applyAdminSaferPlayRestriction(testPlayer.id, {
        type: 'TIMEOUT',
        timeoutUntil: longTimeout,
        now
      });

      // Attempt to shrink to 1h timeout -> must throw TimeoutShrinkError!
      const shortTimeout = new Date(now.getTime() + 1 * 3600 * 1000).toISOString();
      await expect(
        applyAdminSaferPlayRestriction(testPlayer.id, {
          type: 'TIMEOUT',
          timeoutUntil: shortTimeout,
          now
        })
      ).rejects.toThrow(/extended/i);
    });

    it('blocks re-deciding an already finalized dispute', async () => {
      const match = await prisma.match.create({
        data: {
          playerLightId: testPlayer.id,
          playerDarkId: superAdminUser.id,
          tier: 'AMATEUR',
          stakeMinorUnits: 1000n,
          status: 'COMPLETED'
        }
      });

      const dispute = await prisma.disputeCase.create({
        data: {
          matchId: match.id,
          raisedBy: testPlayer.id,
          reason: 'Test claim',
          status: 'OPEN'
        }
      });

      // 1. Initial adjudication -> RESOLVED
      const resDecide1 = await request(app)
        .post(`/api/v1/admin/disputes/${dispute.id}/decide`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ status: 'RESOLVED', resolution: 'First final decision' });
      expect(resDecide1.status).toBe(200);

      // 2. Tampering attempt: try to re-decide -> must be rejected with 409 Conflict
      const resDecide2 = await request(app)
        .post(`/api/v1/admin/disputes/${dispute.id}/decide`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ status: 'DISMISSED', resolution: 'Tampering attempt' });
      expect(resDecide2.status).toBe(409);

      // Clean up
      await prisma.disputeCase.delete({ where: { id: dispute.id } });
      await prisma.match.delete({ where: { id: match.id } });
    });
  });
});
