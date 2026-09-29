import { jest } from '@jest/globals';

process.env.PAYSTACK_SECRET_KEY = 'test_secret_key';
process.env.FLUTTERWAVE_SECRET_KEY = 'test_secret_key';
process.env.FLUTTERWAVE_SECRET_HASH = 'test_secret_hash';

const RAW_ACCOUNT_NUMBER = '0123456789';

const mockPrisma = {
  bankAccount: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn()
  },
  saferPlayProfile: { findUnique: jest.fn() },
  idempotencyRecord: { findUnique: jest.fn(), create: jest.fn() },
  platformSettings: { findFirst: jest.fn() }
};

const mockGetSaferPlayProfile = jest.fn();

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
// The eligibility service (reached through this router) needs
// enforceDepositLimit from the same module, so only override the reader.
const actualSaferPlay = await import('../../saferPlay/service.js');
jest.unstable_mockModule('../../saferPlay/service.js', () => ({
  ...actualSaferPlay,
  getProfile: mockGetSaferPlayProfile
}));

const { default: express } = await import('express');
const { default: request } = await import('supertest');
const { meRouter } = await import('../controller.js');

const app = express();
app.use(express.json());
app.use('/api/v1/me', meRouter);

const bankRow = (over = {}) => ({
  id: 'bank-1',
  userId: 'user-1',
  gateway: 'PAYSTACK',
  bankCode: '011',
  bankName: 'First Bank',
  accountNumber: RAW_ACCOUNT_NUMBER,
  accountName: 'WISDOM RAPTOR',
  providerRecipientCode: 'rcpt_abc',
  isDefault: true,
  verifiedAt: new Date('2026-06-01T00:00:00Z'),
  createdAt: new Date('2026-06-01T00:00:00Z'),
  ...over
});

const saferPlayProfile = {
  depositLimitMinorUnits: '500000',
  effectiveDepositLimitMinorUnits: '500000',
  pendingDepositLimitMinorUnits: null,
  pendingDepositLimitRaisedAt: null,
  stakeLimitMinorUnits: '200000',
  effectiveStakeLimitMinorUnits: '100000',
  pendingStakeLimitMinorUnits: '300000',
  pendingStakeLimitRaisedAt: new Date('2026-06-01T00:00:00Z'),
  timeoutUntil: null,
  selfExcludedUntil: null
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /me/limits (contract §4)', () => {
  it('reports the limits that actually exist, with cooling already resolved', async () => {
    mockGetSaferPlayProfile.mockResolvedValue(saferPlayProfile);
    const res = await request(app).get('/api/v1/me/limits');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      currency: 'NGN',
      depositLimitMinorUnits: '500000',
      effectiveDepositLimitMinorUnits: '500000',
      stakeLimitMinorUnits: '200000',
      // A pending raise inside the cooling window must not be reported as live.
      effectiveStakeLimitMinorUnits: '100000',
      pendingStakeLimitMinorUnits: '300000',
      timeoutUntil: null,
      selfExcludedUntil: null
    });
  });

  it('never invents a withdrawal ceiling', async () => {
    mockGetSaferPlayProfile.mockResolvedValue(saferPlayProfile);
    const res = await request(app).get('/api/v1/me/limits');

    // There is no withdrawal limit in SaferPlayProfile or the frozen schema.
    // Reporting null plus enforced:false is the honest answer; a number here
    // would be a financial rule nobody wrote.
    expect(res.body.data.withdrawal).toEqual({
      limitMinorUnits: null,
      enforced: false,
      note: expect.stringContaining('/me/eligibility?action=WITHDRAW')
    });
  });

  it('still returns a usable payload when the player has no safer-play profile', async () => {
    mockGetSaferPlayProfile.mockResolvedValue(null);
    const res = await request(app).get('/api/v1/me/limits');

    expect(res.status).toBe(200);
    expect(res.body.data.depositLimitMinorUnits).toBeNull();
    expect(res.body.data.stakeLimitMinorUnits).toBeNull();
    expect(res.body.data.withdrawal.enforced).toBe(false);
  });
});

describe('player-facing bank account payloads never carry the raw number', () => {
  it('GET /me/bank-accounts masks the account number', async () => {
    mockPrisma.bankAccount.findMany.mockResolvedValue([bankRow()]);
    const res = await request(app).get('/api/v1/me/bank-accounts');

    expect(res.status).toBe(200);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(RAW_ACCOUNT_NUMBER);
    expect(res.body.data[0]).toMatchObject({
      id: 'bank-1',
      maskedAccountNumber: '••••6789',
      accountName: 'WISDOM RAPTOR',
      bankName: 'First Bank'
    });
    // The full number must not be smuggled back under a different key either.
    expect(Object.keys(res.body.data[0])).not.toContain('accountNumber');
  });
});

describe('POST /me/bank-accounts (contract §2)', () => {
  it('answers 200 like the contract documents, not 201', async () => {
    mockPrisma.bankAccount.findFirst.mockResolvedValue(bankRow());
    mockPrisma.idempotencyRecord.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .post('/api/v1/me/bank-accounts')
      .set('Idempotency-Key', 'bank-account-1')
      .send({ bankCode: '011', accountNumber: RAW_ACCOUNT_NUMBER });

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(RAW_ACCOUNT_NUMBER);
    expect(res.body.data.maskedAccountNumber).toBe('••••6789');
  });
});
