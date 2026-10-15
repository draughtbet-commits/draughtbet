import { jest } from '@jest/globals';

// Clear env vars to prevent real connections via dotenv
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.REDIS_URL = '';

// The Google verifier is exercised on its own in googleProvider.test.js; here
// it is replaced so the service/route contract can be tested deterministically.
class MockGoogleAuthError extends Error {
  constructor(message = 'Google sign-in failed', { status = 401, code = 'GOOGLE_AUTH_FAILED' } = {}) {
    super(message);
    this.name = 'GoogleAuthError';
    this.status = status;
    this.code = code;
  }
}
const verifyGoogleIdToken = jest.fn();
jest.unstable_mockModule('../googleProvider.js', () => ({
  verifyGoogleIdToken,
  GoogleAuthError: MockGoogleAuthError,
  GOOGLE_JWKS_URL: 'https://example.test/jwks',
  resetGoogleJwksCache: jest.fn()
}));

const mockPrisma = {
  $transaction: jest.fn(),
  // ensureUserAccounts creates ledger rows with a native atomic upsert.
  $queryRaw: jest.fn(),
  user: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
  deviceFingerprint: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  userSession: { create: jest.fn() },
  securityEvent: { create: jest.fn() }
};

jest.unstable_mockModule('../../../utils/db.js', () => ({ default: mockPrisma }));

const { default: app } = await import('../../../app.js');
const { default: request } = await import('supertest');
const { AuthService } = await import('../service.js');
const logger = (await import('../../../utils/logger.js')).default;
jest.spyOn(logger, 'error').mockImplementation(() => {});
jest.spyOn(logger, 'info').mockImplementation(() => {});
jest.spyOn(logger, 'warn').mockImplementation(() => {});

const mockRedis = { set: jest.fn(), get: jest.fn(), del: jest.fn(), eval: jest.fn() };
mockRedis.get.mockResolvedValue('ng');

AuthService.__setPrisma(mockPrisma);
AuthService.__setRedis(mockRedis);

const PROFILE = { sub: 'google-sub-1', email: 'player@example.com', emailVerified: true, name: 'Player One', picture: 'https://x/p.png' };

beforeEach(() => {
  jest.clearAllMocks();
  mockRedis.get.mockResolvedValue('ng');
  mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
  mockPrisma.$queryRaw.mockResolvedValue([{ id: 'ledger-acct' }]);
  mockPrisma.userSession.create.mockResolvedValue({ id: 'session-1' });
  mockPrisma.user.create.mockImplementation(async ({ data }) => ({ id: 'new-user', ...data }));
});

describe('POST /api/v1/auth/google', () => {
  it('logs in an existing account and returns tokens', async () => {
    verifyGoogleIdToken.mockResolvedValue(PROFILE);
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'user-1', googleId: null, emailVerified: false });

    const res = await request(app).post('/api/v1/auth/google').send({ idToken: 'a'.repeat(30) });

    expect(res.status).toBe(200);
    expect(res.body.registered).toBe(true);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    // Identity is linked and the email is marked verified on first Google login.
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { googleId: 'google-sub-1', emailVerified: true }
    });
  });

  it('refuses to log in an unknown email and returns the profile to finish sign-up', async () => {
    verifyGoogleIdToken.mockResolvedValue(PROFILE);
    mockPrisma.user.findFirst.mockResolvedValue(null);

    const res = await request(app).post('/api/v1/auth/google').send({ idToken: 'b'.repeat(30) });

    expect(res.status).toBe(200);
    expect(res.body.registered).toBe(false);
    expect(res.body.profile).toEqual({ email: 'player@example.com', fullName: 'Player One', picture: 'https://x/p.png' });
    expect(res.body.accessToken).toBeUndefined();
  });

  it('surfaces a Google verification failure', async () => {
    verifyGoogleIdToken.mockRejectedValue(new MockGoogleAuthError('Invalid Google token'));

    const res = await request(app).post('/api/v1/auth/google').send({ idToken: 'c'.repeat(30) });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid Google token');
  });

  it('rejects a missing token via Zod', async () => {
    const res = await request(app).post('/api/v1/auth/google').send({});
    expect(res.status).toBe(400);
  });
});

describe('AuthService.loginWithGoogle', () => {
  it('does not attempt to relink a user whose Google id already matches', async () => {
    verifyGoogleIdToken.mockResolvedValue(PROFILE);
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'user-1', googleId: 'google-sub-1', emailVerified: true });

    const result = await AuthService.loginWithGoogle({ idToken: 'd'.repeat(30) });

    expect(result.registered).toBe(true);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/auth/register with a Google token', () => {
  const body = {
    email: 'player@example.com',
    dateOfBirth: '2000-01-01',
    countryCode: 'NG',
    geoBinding: 'geo-abcdefgh',
    googleIdToken: 'e'.repeat(30)
  };

  it('creates the account without a password, as verified', async () => {
    verifyGoogleIdToken.mockResolvedValue(PROFILE);

    const res = await request(app).post('/api/v1/auth/register').send(body);

    expect(res.status).toBe(201);
    const createArg = mockPrisma.user.create.mock.calls[0][0];
    expect(createArg.data.email).toBe('player@example.com');
    expect(createArg.data.emailVerified).toBe(true);
    expect(createArg.data.googleId).toBe('google-sub-1');
    // A random password hash is stored, so password login stays impossible.
    expect(typeof createArg.data.passwordHash).toBe('string');
    expect(createArg.data.passwordHash.startsWith('$2')).toBe(true);
  });

  it('rejects a Google token whose email does not match the submitted email', async () => {
    verifyGoogleIdToken.mockResolvedValue({ ...PROFILE, email: 'other@example.com' });

    const res = await request(app).post('/api/v1/auth/register').send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not match/i);
  });

  it('still requires a password when no Google token is supplied', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      email: 'player@example.com',
      dateOfBirth: '2000-01-01',
      countryCode: 'NG',
      geoBinding: 'geo-abcdefgh'
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.errors)).toMatch(/Password is required/);
  });
});
