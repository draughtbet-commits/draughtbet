import { jest, describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import supertest from 'supertest';

const mockAuth = (req, res, next) => {
  req.user = { id: 'user-notif-test' };
  next();
};

const mockPrisma = {
  notification: {
    findMany: jest.fn(async () => []),
    count: jest.fn(async () => 0),
    updateMany: jest.fn(async () => ({ count: 0 })),
  },
};

jest.unstable_mockModule('../../../middleware/auth.js', () => ({ requireAuth: mockAuth }));
jest.unstable_mockModule('../../../utils/db.js', () => ({ default: mockPrisma }));

describe('notification pagination (route level)', () => {
  let app;

  beforeAll(async () => {
    const { notificationRouter } = await import('../controller.js');
    app = express();
    app.use(express.json());
    app.use(notificationRouter);
  });

  it('rejects an oversized limit with 400 and never queries the database', async () => {
    const res = await supertest(app).get('/?limit=1000');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid pagination params');
    expect(mockPrisma.notification.findMany).not.toHaveBeenCalled();
  });

  it('rejects malformed pagination params', async () => {
    for (const qs of ['limit=0', 'limit=-1', 'limit=abc', 'page=nope']) {
      const res = await supertest(app).get(`/?${qs}`);
      expect(res.status).toBe(400);
    }
  });

  it('clamps nothing: a valid limit passes through bounded to Prisma', async () => {
    await supertest(app).get('/?page=3&limit=50');
    expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 100, take: 50 })
    );
  });
});