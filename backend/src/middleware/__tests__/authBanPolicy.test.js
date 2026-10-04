import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';

const mockPrisma = {
  user: { findUnique: jest.fn() }
};

jest.unstable_mockModule('../../utils/db.js', () => ({
  default: mockPrisma
}));

const SECRET = 'test-jwt-secret';
process.env.JWT_SECRET = SECRET;

const { requireAuth } = await import('../auth.js');

describe('requireAuth ban policy', () => {
  const runMiddleware = async (req) => {
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    const next = jest.fn();
    await requireAuth(req, res, next);
    return { res, next };
  };

  const authedReq = (token) => ({
    headers: { authorization: `Bearer ${token}` }
  });

  const sign = (userId = 'user-1') => jwt.sign({ userId }, SECRET);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // A ban restricts ACTIVITY, not ACCESS. Rejecting here would lock the user
  // out of their own balance and support route.
  it('admits a banned account so it can read the app', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'banned@example.com',
      tier: 'AMATEUR',
      isBanned: true,
      isAdmin: false
    });

    const { res, next } = await runMiddleware(authedReq(sign()));

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('attaches the banned user to the request so downstream gates can act', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'banned@example.com',
      tier: 'AMATEUR',
      isBanned: true,
      isAdmin: false
    });

    const req = authedReq(sign());
    await requireAuth(req, { status: jest.fn().mockReturnThis(), json: jest.fn() }, jest.fn());

    expect(req.user).toMatchObject({ id: 'user-1', isBanned: true });
  });

  it('still rejects a deleted or unknown account', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);

    const { res, next } = await runMiddleware(authedReq(sign()));

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('still rejects a request with no token', async () => {
    const { res, next } = await runMiddleware({ headers: {} });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});