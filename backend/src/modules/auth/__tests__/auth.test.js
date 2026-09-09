import { jest } from '@jest/globals';

// Clear env vars to prevent real connections via dotenv
process.env.DATABASE_URL = '';
process.env.REDIS_URL = '';

const mockPrisma = {
  $transaction: jest.fn(),
  user: {
    findUnique: jest.fn(),
    update: jest.fn()
  },
  deviceFingerprint: {
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn()
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
};

const logger = (await import('../../../utils/logger.js')).default;
jest.spyOn(logger, 'error').mockImplementation(() => {});
jest.spyOn(logger, 'info').mockImplementation(() => {});

// Override the module variables for testing
AuthService.__setPrisma(mockPrisma);
AuthService.__setRedis(mockRedis);

// A valid, non-banned user returned by requireAuth's DB lookup.
const authedUser = {
  id: 'user-id',
  email: 'test@example.com',
  tier: 'AMATEUR',
  isBanned: false
};

beforeEach(() => {
  jest.clearAllMocks();
  // requireAuth looks up the user by id for every protected request.
  mockPrisma.user.findUnique.mockResolvedValue(authedUser);
});

describe('Auth System', () => {

  describe('POST /auth/register', () => {
    it('should reject under 18 users via Zod', async () => {
      const res = await request(app)
        .post('/auth/register')
        .send({
          email: 'test@example.com',
          password: 'Password1',
          dateOfBirth: new Date().toISOString() // today, so 0 years old
        });
      expect(res.status).toBe(400);
      expect(res.body.errors[0].message).toMatch(/18 years old/);
    });

    it('should reject weak passwords via Zod', async () => {
      const res = await request(app)
        .post('/auth/register')
        .send({
          email: 'test@example.com',
          password: 'weak',
          dateOfBirth: '2000-01-01'
        });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.errors)).toMatch(/uppercase|lowercase|digit|8/);
    });

    it('should securely log registration failures without raw body', async () => {
      mockPrisma.$transaction.mockRejectedValueOnce(new Error('DB connection failed'));

      const res = await request(app)
        .post('/auth/register')
        .send({
          email: 'test@example.com',
          password: 'StrongPassword1',
          dateOfBirth: '2000-01-01',
          fingerprintHash: 'hash123'
        });

      expect(res.status).toBe(500); // generic error surfaced by express error handler
      expect(logger.error).toHaveBeenCalled();
      const logCall = logger.error.mock.calls[0][0];
      expect(logCall.email).toBe('test@example.com');
      expect(logCall.password).toBeUndefined();
    });

    it('should successfully register user in atomic transaction', async () => {
      mockPrisma.$transaction.mockResolvedValueOnce({ id: 'user-id' });

      const res = await request(app)
        .post('/auth/register')
        .send({
          email: 'test@example.com',
          password: 'StrongPassword1',
          dateOfBirth: '2000-01-01'
        });

      expect(res.status).toBe(201);
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it('should register with username/fullName/address/phone/countryCode and normalize phone', async () => {
      mockPrisma.$transaction.mockResolvedValueOnce({ id: 'user-id' });

      const res = await request(app)
        .post('/auth/register')
        .send({
          phone: '08031234567',
          username: 'skilled_player',
          fullName: 'Jane Doe',
          address: '14 Marina Road, Lagos',
          password: 'StrongPassword1',
          dateOfBirth: '1995-05-10',
          countryCode: 'NG'
        });

      expect(res.status).toBe(201);
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it('should reject registration from a blocked country', async () => {
      const res = await request(app)
        .post('/auth/register')
        .send({
          email: 'test@example.com',
          password: 'StrongPassword1',
          dateOfBirth: '2000-01-01',
          countryCode: 'US'
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('This app is not available in your country');
    });

    it('should reject registration with neither email nor phone via Zod', async () => {
      const res = await request(app)
        .post('/auth/register')
        .send({
          password: 'StrongPassword1',
          dateOfBirth: '2000-01-01'
        });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.errors)).toMatch(/Email or phone is required/);
    });
  });

  describe('POST /auth/check-availability', () => {
    it('should report an email as unavailable when it already exists', async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce({ id: 'existing-user' });

      const res = await request(app)
        .post('/auth/check-availability')
        .send({ type: 'email', value: 'taken@example.com' });

      expect(res.status).toBe(200);
      expect(res.body.available).toBe(false);
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { email: 'taken@example.com' } })
      );
    });

    it('should report a phone as available when it is free', async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce(null);

      const res = await request(app)
        .post('/auth/check-availability')
        .send({ type: 'phone', value: '08031234567' });

      expect(res.status).toBe(200);
      expect(res.body.available).toBe(true);
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { phone: '+08031234567' } })
      );
    });
  });

  describe('POST /auth/geo-locate', () => {
    beforeEach(() => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          address: { country_code: 'ng', country: 'Nigeria' }
        })
      });
    });

    afterEach(() => {
      delete global.fetch;
    });

    it('should return allowed country from coordinates', async () => {
      const res = await request(app)
        .post('/auth/geo-locate')
        .send({ lat: 6.5244, lng: 3.3792 });

      expect(res.status).toBe(200);
      expect(res.body.countryCode).toBe('ng');
      expect(res.body.allowed).toBe(true);
    });

    it('should flag restricted countries as blocked', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          address: { country_code: 'us', country: 'United States' }
        })
      });

      const res = await request(app)
        .post('/auth/geo-locate')
        .send({ lat: 40.7128, lng: -74.0060 });

      expect(res.status).toBe(200);
      expect(res.body.allowed).toBe(false);
    });

    it('should validate coordinate ranges via Zod', async () => {
      const res = await request(app)
        .post('/auth/geo-locate')
        .send({ lat: 999, lng: 0 });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /auth/login', () => {
    it('should reject login if isBanned is true', async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce({
        id: 'user-id',
        email: 'banned@example.com',
        isBanned: true,
        passwordHash: 'hash'
      });

      const res = await request(app)
        .post('/auth/login')
        .send({
          email: 'banned@example.com',
          password: 'StrongPassword1'
        });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Account suspended');
    });

    it('should issue tokens on successful login', async () => {
      const hash = await bcrypt.hash('StrongPassword1', 1);
      mockPrisma.user.findUnique.mockResolvedValueOnce({
        id: 'user-id',
        email: 'test@example.com',
        isBanned: false,
        passwordHash: hash
      });

      const res = await request(app)
        .post('/auth/login')
        .send({
          email: 'test@example.com',
          password: 'StrongPassword1'
        });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('accessToken');
      expect(res.body).toHaveProperty('refreshToken');

      // Redis should have stored the refresh token
      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.stringContaining('refresh:user-id:'),
        'valid',
        'EX',
        expect.any(Number)
      );
    });

    it('should log in with a phone number (non-email identifier)', async () => {
      const hash = await bcrypt.hash('StrongPassword1', 1);
      mockPrisma.user.findUnique.mockResolvedValueOnce({
        id: 'user-id',
        phone: '+08123456789',
        isBanned: false,
        passwordHash: hash
      });

      const res = await request(app)
        .post('/auth/login')
        .send({
          phone: '08123456789',
          password: 'StrongPassword1'
        });

      expect(res.status).toBe(200);
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { phone: '+08123456789' } })
      );
    });
  });

  describe('POST /auth/refresh', () => {
    it('should rotate refresh token and invalidate old one', async () => {
      mockRedis.get.mockResolvedValueOnce('valid');

      const res = await request(app)
        .post('/auth/refresh')
        .send({
          userId: 'user-id',
          refreshToken: 'old-token'
        });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('accessToken');
      expect(res.body).toHaveProperty('refreshToken');
      expect(res.body.refreshToken).not.toBe('old-token');

      // Verify the old token was actively deleted (invalidated)
      expect(mockRedis.del).toHaveBeenCalledWith('refresh:user-id:old-token');
    });
  });

  describe('POST /auth/logout', () => {
    it('should invalidate token on logout', async () => {
      // Need a valid access token to access the route (requireAuth will look up the user)
      const token = (await AuthService.issueTokens('user-id')).accessToken;

      const res = await request(app)
        .post('/auth/logout')
        .set('Authorization', `Bearer ${token}`)
        .send({
          refreshToken: 'token-to-delete'
        });

      expect(res.status).toBe(200);
      // Verify token deleted from Redis
      expect(mockRedis.del).toHaveBeenCalledWith('refresh:user-id:token-to-delete');
    });
  });

  describe('GET /auth/me', () => {
    it('returns profile including the predesigned avatar', async () => {
      const token = (await AuthService.issueTokens('user-id')).accessToken;
      // Both requireAuth's lookup and getProfile hit findUnique, so mock the
      // full profile as the persistent return value.
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-id',
        email: 'test@example.com',
        username: 'skilled_player',
        fullName: 'Jane Doe',
        avatar: 'avatar_03',
        tier: 'AMATEUR',
        isBanned: false,
        wallet: { balanceMinorUnits: 1000n },
        _count: { notifications: 2 }
      });

      const res = await request(app)
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.avatar).toBe('avatar_03');
      expect(res.body.username).toBe('skilled_player');
      expect(res.body.walletBalanceMinorUnits).toBe('1000');
    });
  });

  describe('PATCH /auth/me', () => {
    it('updates the avatar', async () => {
      const token = (await AuthService.issueTokens('user-id')).accessToken;
      mockPrisma.user.update.mockResolvedValueOnce({
        id: 'user-id',
        email: 'test@example.com',
        username: 'skilled_player',
        fullName: 'Jane Doe',
        avatar: 'avatar_07',
        tier: 'AMATEUR'
      });

      const res = await request(app)
        .patch('/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ avatar: 'avatar_07' });

      expect(res.status).toBe(200);
      expect(res.body.avatar).toBe('avatar_07');
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-id' },
        data: { avatar: 'avatar_07' }
      });
    });

    it('rejects an empty avatar id', async () => {
      const token = (await AuthService.issueTokens('user-id')).accessToken;

      const res = await request(app)
        .patch('/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ avatar: '' });

      expect(res.status).toBe(400);
    });
  });

});
