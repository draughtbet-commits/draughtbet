import { jest } from '@jest/globals';
import request from 'supertest';
import app from '../../../app.js';
import { AuthService } from '../service.js';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import bcrypt from 'bcrypt';

// Mock dependencies
jest.mock('@prisma/client');
jest.mock('ioredis');
jest.mock('../../utils/logger.js', () => ({
  __esModule: true,
  default: { error: jest.fn(), info: jest.fn() }
}));

const mockPrisma = {
  $transaction: jest.fn(),
  user: {
    findUnique: jest.fn()
  },
  deviceFingerprint: {
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn()
  }
};
PrismaClient.mockImplementation(() => mockPrisma);

const mockRedis = {
  set: jest.fn(),
  get: jest.fn(),
  del: jest.fn(),
};
Redis.mockImplementation(() => mockRedis);

// Override the module variables for testing
AuthService.__setPrisma(mockPrisma);
AuthService.__setRedis(mockRedis);

describe('Auth System', () => {

  beforeEach(() => {
    jest.clearAllMocks();
  });

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
      const logger = (await import('../../../utils/logger.js')).default;
      
      const res = await request(app)
        .post('/auth/register')
        .send({
          email: 'test@example.com',
          password: 'StrongPassword1',
          dateOfBirth: '2000-01-01',
          fingerprintHash: 'hash123'
        });

      expect(res.status).toBe(500); // generic error surfaced by express error handler
      // Ensure logger didn't receive the password
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
      // Need a valid access token to access the route (mocking auth middleware is another way)
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

});
