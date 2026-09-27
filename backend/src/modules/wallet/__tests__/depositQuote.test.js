// Controller-level contract for the deposit quote route.
//
// The quote is the client's ONLY source of truth for deposit amount, fee,
// total, currency and which gateways exist. Before this route existed the
// Flutter deposit flow had no server-owned fee or payment-method list, and
// correctly refused to invent one — which left deposits unusable.
import { jest } from '@jest/globals';

const mockPrisma = {
  platformSettings: { findUnique: jest.fn() },
  depositIntent: { update: jest.fn() },
  depositQuote: { findUnique: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
  wallet: { findUnique: jest.fn() }
};

// Instances the controller constructs at module load, so tests can drive the
// exact gateway objects the routes call.
const created = { paystack: [], flutterwave: [] };

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
  canDeposit = jest.fn();
  canWithdraw = jest.fn();
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
  requestWithdrawal = jest.fn();
  listWithdrawals = jest.fn();
  listBankAccounts = jest.fn();
  createBankAccount = jest.fn();
  deleteBankAccount = jest.fn();
}

// The real service's error shape, so `instanceof` in the controller is
// exercised for real rather than against a stand-in.
class DepositQuoteError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DepositQuoteError';
    this.code = code;
  }
}

const parseMinorUnits = (raw) => {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const value = BigInt(raw);
  return value > 0n ? value : null;
};

const parseIdempotencyKey = (raw) => {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(raw)) {
    const err = new Error('Invalid idempotency key');
    err.name = 'InvalidIdempotencyKeyError';
    throw err;
  }
  return raw;
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
  createDepositQuote: jest.fn(),
  findDepositQuoteByClientKey: jest.fn(),
  // A plain function, not a jest.fn: `resetAllMocks()` strips mock
  // implementations, which would silently turn every quote into `undefined`.
  depositQuotePayload: (q) => ({ id: q.id, replayedFrom: 'service' }),
  DepositQuoteError,
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
jest.unstable_mockModule('../../eligibility/service.js', () => ({ EligibilityService: EligibilityServiceMock }));

const {
  createDepositIntent,
  createDepositQuote,
  findDepositQuoteByClientKey,
  getDepositIntent
} = await import('../service.js');
const { default: express } = await import('express');
const { default: request } = await import('supertest');
const { walletRouter, depositsRouter } = await import('../controller.js');

const app = express();
app.use(express.json());
app.use('/api/v1/wallet', walletRouter);
app.use('/api/v1/deposits', depositsRouter);

const paystackGateway = created.paystack[0];

// A service-shaped intent row: the controller stringifies amountMinorUnits, so
// a partial stub would throw a 500 and mask the behaviour under test.
const intentRow = (overrides = {}) => ({
  id: 'intent-1',
  userId: 'user-1',
  gateway: 'PAYSTACK',
  reference: 'paystack-1',
  amountMinorUnits: 500000n,
  currency: 'NGN',
  status: 'PENDING',
  authorizationUrl: null,
  appliedAt: null,
  createdAt: new Date('2026-10-07T12:00:00.000Z'),
  updatedAt: new Date('2026-10-07T12:00:00.000Z'),
  ...overrides
});

const quoteRow = (overrides = {}) => ({
  id: 'quote-1',
  userId: 'user-1',
  amountMinorUnits: 500000n,
  currency: 'NGN',
  feeMinorUnits: 0n,
  totalMinorUnits: 500000n,
  paymentMethods: [{ id: 'paystack', label: 'Paystack', description: null, feeMinorUnits: '0' }],
  status: 'ACTIVE',
  idempotencyKey: null,
  expiresAt: new Date('2026-10-07T12:15:00.000Z'),
  createdAt: new Date('2026-10-07T12:00:00.000Z'),
  ...overrides
});

describe('POST /api/v1/wallet/deposit-quote (deposit quote contract)', () => {
  const doQuote = (body = { amountMinorUnits: '500000' }) =>
    request(app).post('/api/v1/wallet/deposit-quote').send(body);

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns the quote under a `quote` envelope so the client can parse it', async () => {
    createDepositQuote.mockResolvedValue({ quote: quoteRow(), replayed: false });

    const res = await doQuote();

    expect(res.status).toBe(200);
    expect(res.body.quote).toEqual({ id: 'quote-1', replayedFrom: 'service' });
    expect(res.body.replayed).toBe(false);
    expect(createDepositQuote).toHaveBeenCalledWith('user-1', '500000', undefined);
  });

  it('passes the Idempotency-Key header through as the quote operation key', async () => {
    createDepositQuote.mockResolvedValue({ quote: quoteRow(), replayed: false });

    await doQuote().set('idempotency-key', 'quote_key_abcdef12');

    expect(createDepositQuote).toHaveBeenCalledWith('user-1', '500000', 'quote_key_abcdef12');
  });

  it('replays the original quote for a repeated Idempotency-Key', async () => {
    findDepositQuoteByClientKey.mockResolvedValue(quoteRow({ idempotencyKey: 'quote_key_abcdef12' }));

    const res = await doQuote().set('idempotency-key', 'quote_key_abcdef12');

    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(true);
    // The replay resolves BEFORE the create, so no second quote is ever made.
    expect(createDepositQuote).not.toHaveBeenCalled();
  });

  it('rejects a malformed Idempotency-Key with 400', async () => {
    const res = await doQuote().set('idempotency-key', 'short');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_IDEMPOTENCY_KEY');
    expect(createDepositQuote).not.toHaveBeenCalled();
  });

  it.each([
    ['INVALID_AMOUNT', 400],
    ['AMOUNT_OUT_OF_RANGE', 400],
    ['QUOTE_NOT_FOUND', 404],
    ['QUOTE_ALREADY_USED', 409],
    ['QUOTE_EXPIRED', 409],
    ['QUOTE_AMOUNT_MISMATCH', 409],
    ['QUOTE_METHOD_UNAVAILABLE', 409],
    ['UNSUPPORTED_CURRENCY', 422],
    ['NO_GATEWAY_AVAILABLE', 503]
  ])('maps %s to HTTP %i rather than a 500', async (code, status) => {
    createDepositQuote.mockRejectedValue(new DepositQuoteError('nope', code));

    const res = await doQuote();

    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
  });

  it('resolves a concurrent same-key create race to the winning quote', async () => {
    createDepositQuote.mockRejectedValue({ code: 'P2002' });
    findDepositQuoteByClientKey.mockResolvedValue(quoteRow({ idempotencyKey: 'quote_key_abcdef12' }));

    const res = await doQuote().set('idempotency-key', 'quote_key_abcdef12');

    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(true);
  });
});

describe('POST /api/v1/wallet/deposit-intent honours quoteId', () => {
  const doCheckout = (body = {}) =>
    request(app).post('/api/v1/wallet/deposit-intent').send({
      amountMinorUnits: '500000',
      gateway: 'paystack',
      ...body
    });

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('forwards a supplied quoteId to the service', async () => {
    createDepositIntent.mockResolvedValue(intentRow());
    paystackGateway.initiatePayment.mockResolvedValue({
      authorizationUrl: 'https://pay.example.com/checkout/1',
      reference: 'paystack-1'
    });

    const res = await doCheckout({ quoteId: 'quote-1' });

    expect(res.status).toBe(200);
    expect(createDepositIntent).toHaveBeenCalledWith(
      'user-1',
      500000n,
      'PAYSTACK',
      'u@example.com',
      undefined,
      'quote-1'
    );
  });

  it('surfaces an unhonourable quote as 409 so the client re-quotes', async () => {
    createDepositIntent.mockRejectedValue(new DepositQuoteError('Deposit quote has expired', 'QUOTE_EXPIRED'));

    const res = await doCheckout({ quoteId: 'quote-1' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('QUOTE_EXPIRED');
  });

  it('ignores a blank quoteId rather than treating it as a real quote', async () => {
    createDepositIntent.mockResolvedValue(intentRow());
    paystackGateway.initiatePayment.mockResolvedValue({
      authorizationUrl: 'https://pay.example.com/checkout/1',
      reference: 'paystack-1'
    });

    const res = await doCheckout({ quoteId: '   ' });

    expect(res.status).toBe(200);
    expect(createDepositIntent).toHaveBeenCalledWith(
      'user-1',
      500000n,
      'PAYSTACK',
      'u@example.com',
      undefined,
      null
    );
  });
});

describe('GET /api/v1/deposits/:depositId resolves the provider reference', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('passes the client-supplied reference straight to the service', async () => {
    // The Flutter client only ever holds the reference, never the intent id.
    getDepositIntent.mockResolvedValue(intentRow());

    const res = await request(app).get('/api/v1/deposits/paystack-8f2c-reference');

    expect(res.status).toBe(200);
    expect(getDepositIntent).toHaveBeenCalledWith('user-1', 'paystack-8f2c-reference');
  });

  it('404s when no intent matches the reference', async () => {
    getDepositIntent.mockResolvedValue(null);

    const res = await request(app).get('/api/v1/deposits/paystack-unknown');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('DEPOSIT_NOT_FOUND');
  });
});
