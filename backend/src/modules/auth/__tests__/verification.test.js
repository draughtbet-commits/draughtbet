import { jest } from '@jest/globals';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.REDIS_URL = '';

const mockPrisma = {
  $transaction: jest.fn(),
  user: {
    findUnique: jest.fn(),
    update: jest.fn()
  },
  userSession: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn()
  },
  verificationChallenge: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    delete: jest.fn()
  },
  securityEvent: {
    create: jest.fn()
  },
  adminRoleAssignment: {
    findMany: jest.fn()
  }
};

jest.unstable_mockModule('../../../utils/db.js', () => ({
  default: mockPrisma
}));

const { default: app } = await import('../../../app.js');
const { default: request } = await import('supertest');
const { AuthService } = await import('../service.js');
const { default: bcrypt } = await import('bcrypt');

const mockRedis = {
  set: jest.fn(),
  get: jest.fn(),
  del: jest.fn(),
  scanStream: jest.fn(),
  eval: jest.fn()
};
mockRedis.get.mockResolvedValue('ng');

const logger = (await import('../../../utils/logger.js')).default;
jest.spyOn(logger, 'error').mockImplementation(() => {});
jest.spyOn(logger, 'info').mockImplementation(() => {});
jest.spyOn(logger, 'warn').mockImplementation(() => {});

AuthService.__setPrisma(mockPrisma);
AuthService.__setRedis(mockRedis);

const authedUser = {
  id: 'user-id',
  email: 'test@example.com',
  phone: '+08031234567',
  tier: 'AMATEUR',
  isBanned: false
};

const realCode = '482913';
const challengeRow = (overrides = {}) => ({
  id: 'challenge-1',
  userId: 'user-id',
  type: 'EMAIL_VERIFY',
  codeHash: 'hashed-code',
  expiresAt: new Date(Date.now() + 300000),
  attempts: 0,
  maxAttempts: 5,
  verifiedAt: null,
  user: { id: 'user-id', email: 'test@example.com', phone: '+08031234567', emailVerified: false, phoneVerified: false },
  ...overrides
});

const issue = async (id = 'user-id') => (await AuthService.issueTokens(id)).accessToken;

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.user.findUnique.mockResolvedValue(authedUser);
  mockPrisma.adminRoleAssignment.findMany.mockResolvedValue([]);
  mockPrisma.securityEvent.create.mockResolvedValue({ id: 'evt-1' });
  mockPrisma.verificationChallenge.update.mockResolvedValue({ id: 'challenge-1', type: 'EMAIL_VERIFY', verifiedAt: new Date() });
  mockPrisma.verificationChallenge.delete.mockResolvedValue({ id: 'challenge-1' });
  jest.spyOn(bcrypt, 'hash').mockResolvedValue('hashed-code');
  jest.spyOn(bcrypt, 'compare').mockResolvedValue(true);
});

describe('POST /auth/verify/start', () => {
  it('creates a challenge and returns the contract envelope', async () => {
    mockPrisma.verificationChallenge.findFirst.mockResolvedValueOnce(null);
    mockPrisma.verificationChallenge.create.mockResolvedValueOnce({ id: 'challenge-1' });
    const token = await issue();

    const res = await request(app)
      .post('/api/v1/auth/verify/start')
      .set('Authorization', `Bearer ${token}`)
      .send({ channel: 'email' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      challengeId: 'challenge-1',
      expiresInSeconds: expect.any(Number),
      resendAfterSeconds: expect.any(Number)
    });
    expect(mockPrisma.verificationChallenge.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-id',
          type: 'EMAIL_VERIFY',
          codeHash: 'hashed-code'
        })
      })
    );
  });

  it('rejects an invalid channel', async () => {
    const token = await issue();
    const res = await request(app)
      .post('/api/v1/auth/verify/start')
      .set('Authorization', `Bearer ${token}`)
      .send({ channel: 'sms' });

    expect(res.status).toBe(400);
  });

  it('accepts a destination that matches the saved contact', async () => {
    mockPrisma.verificationChallenge.findFirst.mockResolvedValueOnce(null);
    mockPrisma.verificationChallenge.create.mockResolvedValueOnce({ id: 'challenge-1' });
    const token = await issue();

    const res = await request(app)
      .post('/api/v1/auth/verify/start')
      .set('Authorization', `Bearer ${token}`)
      .send({ channel: 'email', destination: 'test@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.data.challengeId).toBe('challenge-1');
  });

  it('rejects a destination that does not match the account contact', async () => {
    const token = await issue();

    const res = await request(app)
      .post('/api/v1/auth/verify/start')
      .set('Authorization', `Bearer ${token}`)
      .send({ channel: 'email', destination: 'someone-else@example.com' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DESTINATION_MISMATCH');
    expect(mockPrisma.verificationChallenge.create).not.toHaveBeenCalled();
  });

  it('requires authentication', async () => {
    const res = await request(app)
      .post('/api/v1/auth/verify/start')
      .send({ channel: 'email' });

    expect(res.status).toBe(401);
  });

  it('rate limits rapid resends', async () => {
    const now = Date.now();
    const recent = new Date(now - 10000); // 10s ago, inside the 60s cooldown
    mockPrisma.verificationChallenge.findFirst.mockResolvedValueOnce({ createdAt: recent });
    const token = await issue();

    const res = await request(app)
      .post('/api/v1/auth/verify/start')
      .set('Authorization', `Bearer ${token}`)
      .send({ channel: 'email' });

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(res.body.error.resendAfterSeconds).toBeGreaterThan(0);
  });
});

describe('POST /auth/verify/confirm', () => {
  it('marks the contact verified', async () => {
    mockPrisma.verificationChallenge.findUnique.mockResolvedValueOnce(challengeRow());
    const token = await issue();

    const res = await request(app)
      .post('/api/v1/auth/verify/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ challengeId: 'challenge-1', code: realCode });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ verified: true, channel: 'email' });
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-id' },
      data: { emailVerified: true }
    });
  });

  it('rejects a challenge that belongs to another user', async () => {
    mockPrisma.verificationChallenge.findUnique.mockResolvedValueOnce(
      challengeRow({ userId: 'other-user', user: { id: 'other-user', email: 'o@o.com' } })
    );
    const token = await issue();

    const res = await request(app)
      .post('/api/v1/auth/verify/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ challengeId: 'challenge-1', code: realCode });

    expect(res.status).toBe(403);
  });

  it('rejects a reset challenge on the confirm endpoint', async () => {
    mockPrisma.verificationChallenge.findUnique.mockResolvedValueOnce(
      challengeRow({ type: 'PASSWORD_RESET' })
    );
    const token = await issue();

    const res = await request(app)
      .post('/api/v1/auth/verify/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ challengeId: 'challenge-1', code: realCode });

    expect(res.status).toBe(403);
  });

  it('returns OTP_EXPIRED for a stale challenge', async () => {
    mockPrisma.verificationChallenge.findUnique.mockResolvedValueOnce(
      challengeRow({ expiresAt: new Date(Date.now() - 1000) })
    );
    const token = await issue();

    const res = await request(app)
      .post('/api/v1/auth/verify/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ challengeId: 'challenge-1', code: realCode });

    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('OTP_EXPIRED');
  });
});

describe('POST /auth/forgot-password', () => {
  it('mints a reset challenge for a known account', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce({ id: 'user-id', isBanned: false });
    mockPrisma.verificationChallenge.findFirst.mockResolvedValueOnce(null);
    mockPrisma.verificationChallenge.create.mockResolvedValueOnce({ id: 'reset-1' });

    const res = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ identifier: 'test@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ accepted: true });
    expect(mockPrisma.verificationChallenge.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'user-id', type: 'PASSWORD_RESET' })
      })
    );
  });

  it('does not enumerate (unknown account still accepted)', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce(null);

    const res = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ identifier: 'nobody@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ accepted: true });
    expect(mockPrisma.verificationChallenge.create).not.toHaveBeenCalled();
  });
});

describe('POST /auth/reset-password', () => {
  it('updates the password and revokes every session', async () => {
    mockPrisma.verificationChallenge.findUnique.mockResolvedValueOnce(
      challengeRow({ type: 'PASSWORD_RESET', user: { id: 'user-id' } })
    );
    mockPrisma.userSession.updateMany.mockResolvedValueOnce({ count: 2 });
    mockRedis.scanStream.mockImplementation(() => ({
      [Symbol.asyncIterator]: async function* () { yield ['refresh:user-id:tok1']; }
    }));

    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ challengeId: 'challenge-1', code: realCode, newPassword: 'NewPassword1' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ reset: true, sessionsRevoked: true });
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-id' },
      data: { passwordHash: 'hashed-code' }
    });
    expect(mockPrisma.userSession.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-id', status: { in: ['ACTIVE', 'EXPIRED'] } },
      data: { status: 'REVOKED' }
    });
    expect(mockPrisma.securityEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'user-id', type: 'PASSWORD_CHANGED' })
      })
    );
  });

  it('rejects a verify challenge on the reset endpoint', async () => {
    mockPrisma.verificationChallenge.findUnique.mockResolvedValueOnce(
      challengeRow({ type: 'EMAIL_VERIFY' })
    );

    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ challengeId: 'challenge-1', code: realCode, newPassword: 'NewPassword1' });

    expect(res.status).toBe(403);
  });

  it('rejects an invalid code', async () => {
    bcrypt.compare.mockResolvedValueOnce(false);
    mockPrisma.verificationChallenge.findUnique.mockResolvedValueOnce(
      challengeRow({ type: 'PASSWORD_RESET', attempts: 1 })
    );

    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ challengeId: 'challenge-1', code: '000000', newPassword: 'NewPassword1' });

    expect(res.status).toBe(400);
    expect(mockPrisma.verificationChallenge.update).toHaveBeenCalledWith({
      where: { id: 'challenge-1' },
      data: { attempts: 2 }
    });
  });
});

describe('delivery rollback on failure', () => {
  it('deletes the challenge and rethrows when delivery throws', async () => {
    mockPrisma.verificationChallenge.findFirst.mockResolvedValueOnce(null);
    mockPrisma.verificationChallenge.create.mockResolvedValueOnce({ id: 'challenge-1' });
    const boom = new Error('provider down');

    await expect(AuthService.startContactVerification('user-id', {
      channel: 'email',
      deliver: async () => { throw boom; }
    })).rejects.toThrow('provider down');

    expect(mockPrisma.verificationChallenge.delete).toHaveBeenCalledWith({ where: { id: 'challenge-1' } });
  });

  it('delete failure still rethrows the original delivery error', async () => {
    mockPrisma.verificationChallenge.findFirst.mockResolvedValueOnce(null);
    mockPrisma.verificationChallenge.create.mockResolvedValueOnce({ id: 'challenge-1' });
    mockPrisma.verificationChallenge.delete.mockRejectedValueOnce(new Error('db down'));

    await expect(AuthService.startContactVerification('user-id', {
      channel: 'email',
      deliver: async () => { throw new Error('provider down'); }
    })).rejects.toThrow('provider down');
  });
});

describe('GET /me/sessions', () => {
  it('lists active sessions and flags the requesting one as current', async () => {
    mockPrisma.userSession.findMany.mockResolvedValueOnce([
      { id: 'cur-session', lastRotatedAt: new Date(), status: 'ACTIVE', deviceInfo: { model: 'Pixel 8' } },
      { id: 'old-session', lastRotatedAt: new Date(Date.now() - 86400000), status: 'ACTIVE', deviceInfo: null }
    ]);
    const token = (await AuthService.issueTokens('user-id')).accessToken;
    // Bind the access token to the current session row that listSessions must mark.
    AuthService.__setPrisma(mockPrisma);
    mockPrisma.userSession.create.mockResolvedValueOnce({ id: 'cur-session' });
    const boundToken = (await AuthService.issueTokens('user-id')).accessToken;

    const res = await request(app)
      .get('/api/v1/me/sessions')
      .set('Authorization', `Bearer ${boundToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toEqual({
      sessionId: 'cur-session',
      deviceName: 'Pixel 8',
      lastUsedAt: expect.any(String),
      current: true
    });
    expect(res.body.data[1].current).toBe(false);
  });
});

describe('DELETE /me/sessions/:sessionId', () => {
  it('revokes an active session owned by the user', async () => {
    mockPrisma.userSession.findUnique.mockResolvedValueOnce({
      id: 'old-session',
      userId: 'user-id',
      status: 'ACTIVE'
    });
    const token = await issue();

    const res = await request(app)
      .delete('/api/v1/me/sessions/old-session')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ revoked: true, alreadyRevoked: false });
    expect(mockPrisma.userSession.update).toHaveBeenCalledWith({
      where: { id: 'old-session' },
      data: { status: 'REVOKED' }
    });
  });

  it('refuses to revoke a session owned by someone else', async () => {
    mockPrisma.userSession.findUnique.mockResolvedValueOnce({
      id: 'their-session',
      userId: 'other-user',
      status: 'ACTIVE'
    });
    const token = await issue();

    const res = await request(app)
      .delete('/api/v1/me/sessions/their-session')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(mockPrisma.userSession.update).not.toHaveBeenCalled();
  });

  it('returns a neutral already-revoked result for repeated calls', async () => {
    mockPrisma.userSession.findUnique.mockResolvedValueOnce({
      id: 'old-session',
      userId: 'user-id',
      status: 'REVOKED'
    });
    const token = await issue();

    const res = await request(app)
      .delete('/api/v1/me/sessions/old-session')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ revoked: true, alreadyRevoked: true });
  });
});