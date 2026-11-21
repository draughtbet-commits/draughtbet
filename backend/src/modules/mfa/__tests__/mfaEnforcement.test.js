import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { generateTotp } from '../../../utils/totp.js';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.REDIS_URL = '';

const sessionsByHash = new Map();
let mfaRow = null;
let adminUser = null;

const mockPrisma = {
  $transaction: jest.fn(async (cb) => cb(mockPrisma)),
  user: {
    findUnique: jest.fn(async ({ where }) => {
      if (where?.id === adminUser?.id || where?.email === adminUser?.email) {
        return adminUser;
      }
      return null;
    }),
    update: jest.fn()
  },
  adminRoleAssignment: {
    findMany: jest.fn(async ({ where }) =>
      where?.userId === adminUser?.id ? [{ role: { name: 'SUPER_ADMIN' } }] : []
    )
  },
  adminMfa: {
    findUnique: jest.fn(async ({ where }) => (where?.userId === adminUser?.id ? mfaRow : null)),
    upsert: jest.fn(async ({ create, update }) => {
      mfaRow = mfaRow ? { ...mfaRow, ...update } : { id: 'mfa-row-1', ...create };
      return mfaRow;
    }),
    update: jest.fn(async ({ data }) => {
      mfaRow = { ...mfaRow, ...data };
      return mfaRow;
    }),
    delete: jest.fn(async () => {
      const prev = mfaRow;
      mfaRow = null;
      return prev;
    })
  },
  userSession: {
    create: jest.fn(async ({ data }) => {
      const row = { id: `sess-${sessionsByHash.size + 1}`, ...data };
      sessionsByHash.set(data.refreshTokenHash, row);
      return row;
    }),
    findUnique: jest.fn(async ({ where }) => sessionsByHash.get(where.refreshTokenHash) ?? null),
    update: jest.fn(async ({ where, data }) => {
      const row = sessionsByHash.get(where.refreshTokenHash);
      if (row) Object.assign(row, data);
      return row;
    }),
    updateMany: jest.fn(async ({ where, data }) => {
      let count = 0;
      for (const row of sessionsByHash.values()) {
        if (where.userId && row.userId !== where.userId) continue;
        if (where.family && row.family !== where.family) continue;
        if (where.refreshTokenHash && row.refreshTokenHash !== where.refreshTokenHash) continue;
        if (where.status) {
          if (typeof where.status === 'string' && row.status !== where.status) continue;
          if (where.status.in && !where.status.in.includes(row.status)) continue;
        }
        Object.assign(row, data);
        count += 1;
      }
      return { count };
    })
  },
  adminAuditLog: {
    create: jest.fn().mockResolvedValue({ id: 'audit-1' })
  },
  securityEvent: {
    create: jest.fn().mockResolvedValue({ id: 'sec-1' })
  }
};

jest.unstable_mockModule('../../../utils/db.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../../utils/redis.js', () => ({
  default: null,
  isRedisReady: () => false
}));
jest.unstable_mockModule('../../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  httpLogger: (_req, _res, next) => next()
}));

const { default: app } = await import('../../../app.js');
const { default: request } = await import('supertest');
const { AuthService } = await import('../../auth/service.js');
const { AdminMfaService } = await import('../service.js');

AuthService.__setPrisma(mockPrisma);
AuthService.__setRedis(null);

describe('Admin MFA Enforcement & Anti-Bypass (Login, Refresh, Recovery)', () => {
  const originalEnforced = process.env.ADMIN_MFA_ENFORCED;

  beforeEach(async () => {
    jest.clearAllMocks();
    sessionsByHash.clear();
    mfaRow = null;
    AdminMfaService.clearLocalState();
    process.env.ADMIN_MFA_ENFORCED = 'true';

    adminUser = {
      id: 'admin-mfa-1',
      email: 'mfa-admin@draughtbet.com',
      username: 'mfaadmin',
      fullName: 'MFA Admin',
      tier: 'PRO',
      isBanned: false,
      isAdmin: true,
      passwordHash: await bcrypt.hash('StrongAdminPass1!', 1)
    };
  });

  afterEach(() => {
    if (originalEnforced === undefined) delete process.env.ADMIN_MFA_ENFORCED;
    else process.env.ADMIN_MFA_ENFORCED = originalEnforced;
  });

  it('blocks protected admin endpoints until enrolled & verified, and prevents refresh bypass', async () => {
    // 1. Login produces a pre-MFA session (mfaVerified: false)
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: adminUser.email, password: 'StrongAdminPass1!' });
    expect(loginRes.status).toBe(200);
    const { accessToken, refreshToken } = loginRes.body;

    // 2. /admin/me works before MFA so the console can display enrollment/challenge UI
    const meBefore = await request(app)
      .get('/api/v1/admin/me')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(meBefore.status).toBe(200);
    expect(meBefore.body.mfa).toMatchObject({
      enforced: true,
      provisioned: false,
      enabled: false,
      verified: false
    });

    // 3. Protected admin route is denied before MFA enrollment
    const deniedBefore = await request(app)
      .get('/api/v1/admin/roles')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(deniedBefore.status).toBe(403);
    expect(deniedBefore.body.code).toBe('MFA_ENROLLMENT_REQUIRED');

    // 4. Attempting to bypass MFA via /auth/refresh MUST NOT elevate mfaVerified
    const refreshBefore = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ userId: adminUser.id, refreshToken });
    expect(refreshBefore.status).toBe(200);
    const deniedAfterRefresh = await request(app)
      .get('/api/v1/admin/roles')
      .set('Authorization', `Bearer ${refreshBefore.body.accessToken}`);
    expect(deniedAfterRefresh.status).toBe(403);

    // 5. Enroll MFA via /admin/mfa/setup + /admin/mfa/verify
    const setupRes = await request(app)
      .post('/api/v1/admin/mfa/setup')
      .set('Authorization', `Bearer ${refreshBefore.body.accessToken}`)
      .send({});
    expect(setupRes.status).toBe(201);
    const { base32, recoveryCodes } = setupRes.body;
    expect(recoveryCodes).toHaveLength(8);

    // Still denied while provisioned but not enabled
    const deniedProvisioned = await request(app)
      .get('/api/v1/admin/roles')
      .set('Authorization', `Bearer ${refreshBefore.body.accessToken}`);
    expect(deniedProvisioned.status).toBe(403);

    // Confirm enrollment with TOTP -> returns upgraded MFA-verified tokens
    const enableRes = await request(app)
      .post('/api/v1/admin/mfa/verify')
      .set('Authorization', `Bearer ${refreshBefore.body.accessToken}`)
      .send({ code: generateTotp(base32, { timestamp: Date.now() - 30_000 }) });
    expect(enableRes.status).toBe(200);
    expect(enableRes.body.enabled).toBe(true);
    expect(enableRes.body.mfaVerified).toBe(true);
    const verifiedToken = enableRes.body.accessToken;

    // 6. Fresh login with password alone STILL requires MFA challenge (cannot bypass!)
    const secondLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: adminUser.email, password: 'StrongAdminPass1!' });
    expect(secondLogin.status).toBe(200);

    const blockedSecond = await request(app)
      .get('/api/v1/admin/roles')
      .set('Authorization', `Bearer ${secondLogin.body.accessToken}`);
    expect(blockedSecond.status).toBe(403);
    expect(blockedSecond.body.code).toBe('MFA_REQUIRED');

    // Refreshing the second unverified login STILL returns 403 MFA_REQUIRED
    const secondRefreshed = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ userId: adminUser.id, refreshToken: secondLogin.body.refreshToken });
    expect(secondRefreshed.status).toBe(200);
    const blockedSecondRefreshed = await request(app)
      .get('/api/v1/admin/roles')
      .set('Authorization', `Bearer ${secondRefreshed.body.accessToken}`);
    expect(blockedSecondRefreshed.status).toBe(403);

    // 7. Recovery code flow upgrades session once, and replay of recovery code fails
    const recoverRes = await request(app)
      .post('/api/v1/admin/mfa/recover')
      .set('Authorization', `Bearer ${secondRefreshed.body.accessToken}`)
      .send({ recoveryCode: recoveryCodes[0] });
    expect(recoverRes.status).toBe(200);
    expect(recoverRes.body.verified).toBe(true);
    expect(recoverRes.body.recoveryCodesRemaining).toBe(7);

    // Replay of consumed recovery code MUST fail
    const replayRecover = await request(app)
      .post('/api/v1/admin/mfa/recover')
      .set('Authorization', `Bearer ${secondRefreshed.body.accessToken}`)
      .send({ recoveryCode: recoveryCodes[0] });
    expect(replayRecover.status).toBe(403);

    // Verify upgraded token passes MFA gate (hits handler; mock returns 200 or next layer)
    const meVerified = await request(app)
      .get('/api/v1/admin/me')
      .set('Authorization', `Bearer ${recoverRes.body.accessToken}`);
    expect(meVerified.status).toBe(200);
    expect(meVerified.body.mfa.verified).toBe(true);
    expect(verifiedToken).toBeTruthy();

    // 8. Disabling MFA revokes active sessions so old refresh tokens cannot rotate
    const disableRes = await request(app)
      .post('/api/v1/admin/mfa/disable')
      .set('Authorization', `Bearer ${recoverRes.body.accessToken}`)
      .send({ code: generateTotp(base32) });
    expect(disableRes.status).toBe(200);
    expect(disableRes.body.disabled).toBe(true);

    const postDisableRefresh = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ userId: adminUser.id, refreshToken: recoverRes.body.refreshToken });
    expect(postDisableRefresh.status).toBe(401);
  });
});
