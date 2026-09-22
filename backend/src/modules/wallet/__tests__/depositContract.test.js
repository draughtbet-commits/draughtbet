import { jest } from '@jest/globals';

const mockPrisma = {
  depositIntent: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    aggregate: jest.fn()
  }
};

// Instances the controller constructs at module load get captured so tests can
// drive the exact gateway/eligibility objects the routes use.
const created = { paystack: [], flutterwave: [], eligibility: [] };

class PaystackGateway {
  constructor() {
    this.initiatePayment = jest.fn();
    created.paystack.push(this);
  }
}

class FlutterwaveGateway {
  constructor() {
    this.initiatePayment = jest.fn();
    created.flutterwave.push(this);
  }
}

class PaymentGatewayError extends Error {
  constructor(message = 'Gateway error') {
    super(message);
    this.name = 'PaymentGatewayError';
  }
}

class EligibilityServiceMock {
  constructor() {
    this.canDeposit = jest.fn();
    this.canWithdraw = jest.fn();
    created.eligibility.push(this);
  }
  static statusCode() {
    return 500;
  }
}

class BankAccountNotFoundError extends Error {
  constructor(message = 'Bank account not found') {
    super(message);
    this.name = 'BankAccountNotFoundError';
  }
}

class WithdrawalServiceMock {
  constructor() {
    this.requestWithdrawal = jest.fn();
    this.listWithdrawals = jest.fn();
    this.listBankAccounts = jest.fn();
    this.createBankAccount = jest.fn();
    this.deleteBankAccount = jest.fn();
  }
}

const parseIdempotencyKey = (raw) => {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(raw)) {
    const err = new Error('Invalid idempotency key');
    err.name = 'InvalidIdempotencyKeyError';
    throw err;
  }
  return raw;
};

const parseMinorUnits = (raw) => {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const value = BigInt(raw);
  return value > 0n ? value : null;
};

jest.unstable_mockModule('../../../utils/db.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.unstable_mockModule('../../../middleware/auth.js', () => ({
  requireAuth: (req, res, next) => {
    req.user = { id: 'user-1', email: 'u@example.com' };
    next();
  }
}));
jest.unstable_mockModule('../service.js', () => ({
  getWalletBalance: jest.fn(),
  getWalletTransactions: jest.fn(),
  createDepositIntent: jest.fn(),
  findDepositIntentByClientKey: jest.fn(),
  getDepositIntent: jest.fn(),
  parseMinorUnits,
  parseIdempotencyKey
}));
jest.unstable_mockModule('../../payment/PaystackGateway.js', () => ({ PaystackGateway }));
jest.unstable_mockModule('../../payment/FlutterwaveGateway.js', () => ({ FlutterwaveGateway }));
jest.unstable_mockModule('../../payment/PaymentGateway.js', () => ({ PaymentGatewayError }));
jest.unstable_mockModule('../../withdrawal/service.js', () => ({
  WithdrawalService: WithdrawalServiceMock,
  BankAccountNotFoundError
}));
jest.unstable_mockModule('../../eligibility/service.js', () => ({
  EligibilityService: EligibilityServiceMock
}));

const {
  createDepositIntent,
  findDepositIntentByClientKey,
  getDepositIntent
} = await import('../service.js');
const { default: express } = await import('express');
const { default: request } = await import('supertest');
const { walletRouter, depositsRouter } = await import('../controller.js');

const paystackGateway = created.paystack[0];
const flutterwaveGateway = created.flutterwave[0];
const eligibilityService = created.eligibility[0];

const app = express();
app.use(express.json());
app.use('/api/v1/wallet', walletRouter);
app.use('/api/v1/deposits', depositsRouter);

describe('deposit checkout — client Idempotency-Key replay (contract §6 / decision §39)', () => {
  const doCheckout = (overrides = {}) =>
    request(app).post('/api/v1/wallet/deposit-intent').send({
      amountMinorUnits: '5000',
      gateway: 'paystack',
      ...(overrides.body || {})
    });

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('replays the original intent when the client key already exists', async () => {
    createDepositIntent.mockResolvedValue({
      id: 'intent-1',
      amountMinorUnits: 5000n,
      reference: 'paystack-original'
    });
    findDepositIntentByClientKey.mockResolvedValue({
      id: 'intent-1',
      userId: 'user-1',
      authorizationUrl: 'https://pay.example.com/checkout/abc',
      reference: 'paystack-original'
    });

    const res = await doCheckout().set('idempotency-key', 'checkout_key_abcdef12');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      authorizationUrl: 'https://pay.example.com/checkout/abc',
      reference: 'paystack-original',
      replayed: true
    });
    expect(findDepositIntentByClientKey).toHaveBeenCalledWith('user-1', 'checkout_key_abcdef12');
    expect(eligibilityService.canDeposit).not.toHaveBeenCalled();
    expect(paystackGateway.initiatePayment).not.toHaveBeenCalled();
  });

  it('resolves the replay BEFORE the eligibility gate (a stale-eligibility replay still returns)', async () => {
    findDepositIntentByClientKey.mockResolvedValue({
      id: 'intent-1',
      authorizationUrl: 'https://pay.example.com/checkout/abc',
      reference: 'paystack-original'
    });
    eligibilityService.canDeposit.mockRejectedValue(
      new Error('Deposit would exceed your daily limit')
    );

    const res = await doCheckout().set('idempotency-key', 'checkout_key_abcdef12');
    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(true);
    expect(eligibilityService.canDeposit).not.toHaveBeenCalled();
  });

  it('creates a fresh checkout when the key is new', async () => {
    findDepositIntentByClientKey.mockResolvedValue(null);
    createDepositIntent.mockResolvedValue({
      id: 'intent-2',
      amountMinorUnits: 5000n,
      reference: 'paystack-fresh'
    });
    paystackGateway.initiatePayment.mockResolvedValue({
      authorizationUrl: 'https://pay.example.com/checkout/fresh',
      reference: 'paystack-fresh'
    });
    mockPrisma.depositIntent.update.mockResolvedValue({ id: 'intent-2', status: 'PENDING' });

    const res = await doCheckout().set('idempotency-key', 'checkout_key_abcdef12');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      authorizationUrl: 'https://pay.example.com/checkout/fresh',
      reference: 'paystack-fresh'
    });
    expect(res.body).not.toHaveProperty('replayed');
    expect(createDepositIntent).toHaveBeenCalledWith(
      'user-1',
      5000n,
      'PAYSTACK',
      'u@example.com',
      'checkout_key_abcdef12'
    );
    expect(paystackGateway.initiatePayment).toHaveBeenCalledTimes(1);
  });

  it('turns a P2002 create race into the same replay response', async () => {
    findDepositIntentByClientKey
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        id: 'intent-existing',
        authorizationUrl: 'https://pay.example.com/checkout/winning',
        reference: 'paystack-winning'
      });
    createDepositIntent.mockRejectedValue(Object.assign(new Error('unique violation'), { code: 'P2002' }));

    const res = await doCheckout().set('idempotency-key', 'checkout_key_abcdef12');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      authorizationUrl: 'https://pay.example.com/checkout/winning',
      reference: 'paystack-winning',
      replayed: true
    });
    expect(createDepositIntent).toHaveBeenCalledTimes(1);
  });

  it('marks the intent FAILED and returns 503 when the provider checkout fails', async () => {
    findDepositIntentByClientKey.mockResolvedValue(null);
    createDepositIntent.mockResolvedValue({ id: 'intent-3', amountMinorUnits: 5000n });
    paystackGateway.initiatePayment.mockRejectedValue(new PaymentGatewayError('provider down'));
    mockPrisma.depositIntent.update.mockResolvedValue({ id: 'intent-3', status: 'FAILED' });

    const res = await doCheckout();
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('provider down');
    expect(mockPrisma.depositIntent.update).toHaveBeenCalledWith({
      where: { id: 'intent-3' },
      data: { status: 'FAILED' }
    });
  });

  it('rejects a malformed idempotency key', async () => {
    const res = await doCheckout().set('idempotency-key', 'short');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_IDEMPOTENCY_KEY');
    expect(createDepositIntent).not.toHaveBeenCalled();
  });
});

describe('GET /deposits/:depositId (contract §6)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns the owning player deposit state', async () => {
    getDepositIntent.mockResolvedValue({
      id: 'dep-1',
      userId: 'user-1',
      gateway: 'PAYSTACK',
      reference: 'paystack-dep-1',
      amountMinorUnits: 5000n,
      currency: 'NGN',
      status: 'PENDING',
      authorizationUrl: 'https://pay.example.com/checkout/abc',
      appliedAt: null,
      createdAt: new Date('2026-06-01T00:00:00Z'),
      updatedAt: new Date('2026-06-01T00:00:00Z')
    });

    const res = await request(app).get('/api/v1/deposits/dep-1');
    expect(res.status).toBe(200);
    expect(res.body.deposit).toMatchObject({
      id: 'dep-1',
      reference: 'paystack-dep-1',
      amountMinorUnits: '5000',
      status: 'PENDING',
      authorizationUrl: 'https://pay.example.com/checkout/abc'
    });
    expect(getDepositIntent).toHaveBeenCalledWith('user-1', 'dep-1');
  });

  it('404s an unknown or foreign deposit', async () => {
    getDepositIntent.mockResolvedValue(null);
    const res = await request(app).get('/api/v1/deposits/dep-9');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('DEPOSIT_NOT_FOUND');
  });
});