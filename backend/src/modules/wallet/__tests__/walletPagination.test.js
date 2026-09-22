import { jest, describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import supertest from 'supertest';

const mockAuth = (req, res, next) => {
  req.user = { id: 'user-pagination-test' };
  next();
};

const mockService = {
  getWalletTransactions: jest.fn(async () => ({ transactions: [], total: 0, page: 1, totalPages: 0 })),
  getWalletBalance: jest.fn(async () => ({ balanceMinorUnits: '0' })),
  createDepositIntent: jest.fn(),
  parseMinorUnits: jest.fn(),
  parseIdempotencyKey: jest.fn(),
};

jest.unstable_mockModule('../../../middleware/auth.js', () => ({ requireAuth: mockAuth }));
jest.unstable_mockModule('../service.js', () => mockService);

describe('wallet transactions pagination (route level)', () => {
  const PAYSTACK_WARN = 'PAYSTACK_SECRET_KEY is missing from environment variables.';

  beforeAll(() => {
    const loggerWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    return () => loggerWarn.mockRestore();
  });

  describe('oversized page size', () => {
    let app;
    beforeAll(async () => {
      const { walletRouter } = await import('../controller.js');
      app = express();
      app.use(express.json());
      app.use(walletRouter);
    });

    it('rejects an oversized limit with 400 instead of querying the database', async () => {
      const res = await supertest(app).get('/transactions?limit=1000');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid pagination params');
      expect(mockService.getWalletTransactions).not.toHaveBeenCalled();
    });

    it('rejects zero, negative and non-integer limits and pages', async () => {
      for (const qs of ['limit=0', 'limit=-5', 'limit=abc', 'page=0', 'page=-1', 'limit=1.5']) {
        const res = await supertest(app).get(`/transactions?${qs}`);
        expect(res.status).toBe(400);
        expect(mockService.getWalletTransactions).not.toHaveBeenCalled();
      }
    });

    it('passes a valid bounded page/limit through to the service', async () => {
      const res = await supertest(app).get('/transactions?page=2&limit=50');
      expect(res.status).toBe(200);
      expect(mockService.getWalletTransactions).toHaveBeenCalledWith('user-pagination-test', 2, 50);
    });

    it('applies safe defaults when no pagination params are present', async () => {
      const res = await supertest(app).get('/transactions');
      expect(res.status).toBe(200);
      expect(mockService.getWalletTransactions).toHaveBeenCalledWith('user-pagination-test', 1, 20);
    });
  });
});