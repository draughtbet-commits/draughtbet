import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import bcrypt from 'bcrypt';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.REDIS_URL = '';

const sessionsByHash = new Map();
let adminUser;

const mockPrisma = {
  $transaction: jest.fn(async (cb) => cb(mockPrisma)),
  user: {
    findUnique: jest.fn(async ({ where }) => {
      if (where?.id === adminUser?.id || where?.email === adminUser?.email) {
        return adminUser;
      }
      return null;
    })
  },
  adminRoleAssignment: {
    findMany: jest.fn(async ({ where }) =>
      where?.userId === adminUser?.id ? [{ role: { name: 'SUPER_ADMIN' } }] : []
    )
  },
  adminMfa: {
    findUnique: jest.fn().mockResolvedValue(null)
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
        if (where.refreshTokenHash && row.refreshTokenHash !== where.refreshTokenHash) continue;
        if (where.status?.in && !where.status.in.includes(row.status)) continue;
        if (typeof where.status === 'string' && row.status !== where.status) continue;
        Object.assign(row, data);
        count += 1;
      }
      return { count };
    })
  },
  securityEvent: {
    create: jest.fn().mockResolvedValue({ id: 'evt-1' })
  },
  adminAuditLog: {
    create: jest.fn().mockResolvedValue({ id: 'audit-1' })
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
const { AuthService } = await import('../service.js');

AuthService.__setPrisma(mockPrisma);
AuthService.__setRedis(null);

const extractCookieMap = (setCookieHeaders = []) => {
  const map = {};
  for (const raw of setCookieHeaders) {
    const [pair] = raw.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) {
      map[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
  }
  return map;
};

const toCookieHeader = (cookieMap) =>
  Object.entries(cookieMap)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

describe('HttpOnly Cookie JWT Transport, CSRF Defense & Refresh Reuse Detection (Issue #7)', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    sessionsByHash.clear();
    delete process.env.ADMIN_MFA_ENFORCED;
    adminUser = {
      id: 'cookie-admin-1',
      email: 'cookie-admin@draughtbet.com',
      username: 'cookieadmin',
      fullName: 'Cookie Admin',
      tier: 'PRO',
      isBanned: false,
      isAdmin: true,
      passwordHash: await bcrypt.hash('StrongCookiePass1!', 1)
    };
  });

  it('issues HttpOnly access & refresh cookies with SameSite=Strict and exposes zero tokens in JSON', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('X-Auth-Mode', 'cookie')
      .send({ email: adminUser.email, password: 'StrongCookiePass1!' });

    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.accessToken).toBeUndefined();
    expect(res.body.refreshToken).toBeUndefined();
    expect(typeof res.body.csrfToken).toBe('string');

    const setCookies = res.headers['set-cookie'] || [];
    const accessCookie = setCookies.find((c) => c.startsWith('db_admin_access='));
    const refreshCookie = setCookies.find((c) => c.startsWith('db_admin_refresh='));
    const csrfCookie = setCookies.find((c) => c.startsWith('db_csrf_token='));

    expect(accessCookie).toContain('HttpOnly');
    expect(accessCookie).toContain('Path=/api/v1');
    expect(accessCookie).toContain('SameSite=Strict');

    expect(refreshCookie).toContain('HttpOnly');
    expect(refreshCookie).toContain('Path=/api/v1/auth');
    expect(refreshCookie).toContain('SameSite=Strict');

    expect(csrfCookie).toBeDefined();
    expect(csrfCookie).not.toContain('HttpOnly');

    // Cookie-only authenticated GET /admin/me works without Authorization header
    const cookies = extractCookieMap(setCookies);
    const meRes = await request(app)
      .get('/api/v1/admin/me')
      .set('Cookie', toCookieHeader(cookies));
    expect(meRes.status).toBe(200);
    expect(meRes.body.email).toBe(adminUser.email);
  });

  it('blocks cookie-authenticated mutations without a valid signed CSRF token or disallowed Origin', async () => {
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .set('X-Auth-Mode', 'cookie')
      .send({ email: adminUser.email, password: 'StrongCookiePass1!' });

    const cookies = extractCookieMap(loginRes.headers['set-cookie']);
    const cookieHeader = toCookieHeader(cookies);

    // 1. Missing X-CSRF-Token -> 403 CSRF_INVALID
    const missingCsrf = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookieHeader)
      .send({});
    expect(missingCsrf.status).toBe(403);
    expect(missingCsrf.body.code).toBe('CSRF_INVALID');

    // 2. Forged / mismatched X-CSRF-Token -> 403 CSRF_INVALID
    const forgedCsrf = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookieHeader)
      .set('X-CSRF-Token', 'forged.token')
      .send({});
    expect(forgedCsrf.status).toBe(403);
    expect(forgedCsrf.body.code).toBe('CSRF_INVALID');

    // 3. Disallowed Origin when ADMIN_CORS_ORIGIN is pinned -> 403 CSRF_ORIGIN_INVALID
    process.env.ADMIN_CORS_ORIGIN = 'https://admin.draughtbet.com';
    try {
      const evilOrigin = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Origin', 'https://evil.example')
        .set('Cookie', cookieHeader)
        .set('X-CSRF-Token', cookies.db_csrf_token)
        .send({});
      expect(evilOrigin.status).toBe(403);
      expect(evilOrigin.body.code).toBe('CSRF_ORIGIN_INVALID');
    } finally {
      delete process.env.ADMIN_CORS_ORIGIN;
    }
  });

  it('rotates HttpOnly refresh cookies, detects refresh reuse, and revokes on logout', async () => {
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .set('X-Auth-Mode', 'cookie')
      .send({ email: adminUser.email, password: 'StrongCookiePass1!' });
    const c1 = extractCookieMap(loginRes.headers['set-cookie']);

    // Rotate refresh cookie cleanly with valid CSRF header
    const rotRes = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', toCookieHeader(c1))
      .set('X-CSRF-Token', c1.db_csrf_token)
      .send({});
    expect(rotRes.status).toBe(200);
    expect(rotRes.body.authenticated).toBe(true);
    expect(rotRes.body.accessToken).toBeUndefined();
    const c2 = extractCookieMap(rotRes.headers['set-cookie']);
    expect(c2.db_admin_refresh).not.toBe(c1.db_admin_refresh);

    // Replay old c1 refresh cookie -> triggers reuse detection, revokes ALL sessions (including c2), clears cookies
    const replayRes = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', toCookieHeader(c1))
      .set('X-CSRF-Token', c1.db_csrf_token)
      .send({});
    expect(replayRes.status).toBe(401);
    expect(mockPrisma.securityEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'REFRESH_REUSE_DETECTED' })
      })
    );

    // c2 must now also be dead!
    const deadC2 = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', toCookieHeader(c2))
      .set('X-CSRF-Token', c2.db_csrf_token)
      .send({});
    expect(deadC2.status).toBe(401);

    // Fresh login + cookie logout clears all cookies and revokes session
    const login2 = await request(app)
      .post('/api/v1/auth/login')
      .set('X-Auth-Mode', 'cookie')
      .send({ email: adminUser.email, password: 'StrongCookiePass1!' });
    const c3 = extractCookieMap(login2.headers['set-cookie']);

    const logoutRes = await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', toCookieHeader(c3))
      .set('X-CSRF-Token', c3.db_csrf_token)
      .send({});
    expect(logoutRes.status).toBe(200);
    const cleared = (logoutRes.headers['set-cookie'] || []).join(' ');
    expect(cleared).toContain('db_admin_access=;');
    expect(cleared).toContain('db_admin_refresh=;');

    const postLogoutRefresh = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', toCookieHeader(c3))
      .set('X-CSRF-Token', c3.db_csrf_token)
      .send({});
    expect(postLogoutRefresh.status).toBe(401);
  });
});
