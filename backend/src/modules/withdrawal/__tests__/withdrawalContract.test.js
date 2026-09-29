import { jest } from '@jest/globals';

process.env.PAYSTACK_SECRET_KEY = 'test_secret_key';
process.env.FLUTTERWAVE_SECRET_KEY = 'test_secret_key';
process.env.FLUTTERWAVE_SECRET_HASH = 'test_secret_hash';

const mockPrisma = {
  withdrawal: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  idempotencyRecord: {
    findUnique: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({})
  }
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
const { withdrawalUserRouter, withdrawalService: controllerService } = await import('../controller.js');

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
    expect(res.body.data.withdrawal).toMatchObject({
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
describe('POST /withdrawals request + envelope shape (contract §6 guards)', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    mockPrisma.withdrawal.findUnique.mockResolvedValue(withdrawalRow());
  });

  const create = (body, key) =>
    request(app).post('/api/v1/withdrawals').set('Idempotency-Key', key).send(body);

  it('reads the amountMinorUnits body field, like every other money route', async () => {
    const spy = jest
      .spyOn(controllerService, 'requestWithdrawal')
      .mockResolvedValue(withdrawalRow({ amountMinorUnits: 5000n }));

    const res = await create({ amountMinorUnits: 5000, bankAccountId: 'bank-1' }, 'shape-amount-1');

    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith('user-1', 5000, 'shape-amount-1', 'bank-1');
  });

  it('no longer reads the one-off amountMinor field', async () => {
    const spy = jest
      .spyOn(controllerService, 'requestWithdrawal')
      .mockResolvedValue(withdrawalRow());

    await create({ amountMinor: 5000, bankAccountId: 'bank-1' }, 'shape-amount-2');

    expect(spy).toHaveBeenCalledWith('user-1', undefined, 'shape-amount-2', 'bank-1');
  });

  it('gives POST and GET the identical { data: { withdrawal } } envelope', async () => {
    jest.spyOn(controllerService, 'requestWithdrawal').mockResolvedValue(withdrawalRow());

    const created = await create(
      { amountMinorUnits: 3000, bankAccountId: 'bank-1' },
      'shape-envelope-1'
    );
    const fetched = await request(app).get('/api/v1/withdrawals/wd-1');

    expect(Object.keys(created.body)).toEqual(['data']);
    expect(Object.keys(fetched.body)).toEqual(['data']);
    expect(Object.keys(created.body.data)).toEqual(['withdrawal']);
    expect(Object.keys(fetched.body.data)).toEqual(['withdrawal']);
    expect(created.body.data.withdrawal).toEqual(fetched.body.data.withdrawal);
  });

  it('exposes no raw account number, only a masked value', async () => {
    const created = await create(
      { amountMinorUnits: 3000, bankAccountId: 'bank-1' },
      'shape-mask-1'
    );
    expect(JSON.stringify(created.body)).not.toMatch(/accountNumber/i);
  });
});

describe('money-OUT gate refusals are 403, never 500 (contract §6 guards)', () => {
  const denial = (name) => Object.assign(new Error('refused'), { name });

  it.each([
    'EligibilityRequiredError',
    'CountryNotAllowedError',
    'AgeNotVerifiedError',
    'KycRequiredError',
    'AccountRestrictedError',
    'SelfExcludedError'
  ])('maps %s to 403 with the reason', async (name) => {
    jest.spyOn(controllerService, 'requestWithdrawal').mockRejectedValue(denial(name));
    const res = await request(app)
      .post('/api/v1/withdrawals')
      .set('Idempotency-Key', `gate-${name}-1`)
      .send({ amountMinorUnits: 1000, bankAccountId: 'bank-1' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('refused');
  });

  it('still lets genuinely unexpected faults reach the error handler', async () => {
    jest
      .spyOn(controllerService, 'requestWithdrawal')
      .mockRejectedValue(Object.assign(new Error('db gone'), { name: 'InternalError' }));
    const res = await request(app)
      .post('/api/v1/withdrawals')
      .set('Idempotency-Key', 'gate-unexpected-1')
      .send({ amountMinorUnits: 1000, bankAccountId: 'bank-1' });
    // Not swallowed into a 403; with no error middleware it surfaces as 500.
    expect(res.status).toBe(500);
  });
});
