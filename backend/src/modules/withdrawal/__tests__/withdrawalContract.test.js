import { jest } from '@jest/globals';

process.env.PAYSTACK_SECRET_KEY = 'test_secret_key';
process.env.FLUTTERWAVE_SECRET_KEY = 'test_secret_key';
process.env.FLUTTERWAVE_SECRET_HASH = 'test_secret_hash';

const mockPrisma = {
  withdrawal: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() }
};

jest.unstable_mockModule('../../../utils/db.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.unstable_mockModule('../../../middleware/auth.js', () => ({
  requireAuth: (req, res, next) => {
    req.user = { id: 'user-1' };
    next();
  }
}));

const { WithdrawalService } = await import('../service.js');
const { default: express } = await import('express');
const { default: request } = await import('supertest');
const { withdrawalUserRouter } = await import('../controller.js');

const service = new WithdrawalService({
  providers: { PAYSTACK: {}, FLUTTERWAVE: {} }
});

const app = express();
app.use(express.json());
app.use('/api/v1/withdrawals', withdrawalUserRouter);

const withdrawalRow = (over = {}) => ({
  id: 'wd-1',
  userId: 'user-1',
  amountMinorUnits: 3000n,
  currency: 'NGN',
  reference: 'withdrawal-wd-1',
  gateway: 'PAYSTACK',
  status: 'PENDING_REVIEW',
  bankAccountId: 'bank-1',
  providerRef: null,
  reviewedBy: null,
  reviewedAt: null,
  processedAt: null,
  failureReason: null,
  idempotencyKey: null,
  createdAt: new Date('2026-06-01T00:00:00Z'),
  updatedAt: new Date('2026-06-01T00:00:00Z'),
  ...over
});

describe('WithdrawalService getWithdrawal (contract §6)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns the withdrawal for its owner', async () => {
    mockPrisma.withdrawal.findUnique.mockResolvedValue(withdrawalRow());
    const result = await service.getWithdrawal('user-1', 'wd-1');
    expect(result).toMatchObject({ id: 'wd-1', status: 'PENDING_REVIEW' });
    expect(mockPrisma.withdrawal.findUnique).toHaveBeenCalledWith({ where: { id: 'wd-1' } });
  });

  it('returns null for another user’s withdrawal', async () => {
    mockPrisma.withdrawal.findUnique.mockResolvedValue(withdrawalRow({ userId: 'other-1' }));
    const result = await service.getWithdrawal('user-1', 'wd-1');
    expect(result).toBeNull();
  });

  it('returns null when the withdrawal does not exist', async () => {
    mockPrisma.withdrawal.findUnique.mockResolvedValue(null);
    const result = await service.getWithdrawal('user-1', 'wd-missing');
    expect(result).toBeNull();
  });
});

describe('GET /withdrawals/:withdrawalId (contract §6)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns the owning player withdrawal state', async () => {
    mockPrisma.withdrawal.findUnique.mockResolvedValue(withdrawalRow());
    const res = await request(app).get('/api/v1/withdrawals/wd-1');
    expect(res.status).toBe(200);
    expect(res.body.withdrawal).toMatchObject({
      id: 'wd-1',
      amountMinorUnits: '3000',
      reference: 'withdrawal-wd-1',
      status: 'PENDING_REVIEW'
    });
  });

  it('404s an unknown or foreign withdrawal', async () => {
    mockPrisma.withdrawal.findUnique.mockResolvedValue(null);
    const res = await request(app).get('/api/v1/withdrawals/wd-9');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('WITHDRAWAL_NOT_FOUND');
  });
});