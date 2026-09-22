import { jest } from '@jest/globals';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.REDIS_URL = '';
// auth/service.js loads dotenv at import time; pin the JWT secret up front so
// middleware and token signing agree regardless of import ordering.
process.env.JWT_SECRET = 'unittest-admin-secret';

const mockPrisma = {
  $transaction: jest.fn(),
  user: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn()
  },
  adminRoleAssignment: {
    findMany: jest.fn(),
    groupBy: jest.fn()
  },
  adminRole: {
    findUnique: jest.fn(),
    findUniqueOrThrow: jest.fn()
  },
  disputeCase: {
    findMany: jest.fn(),
    count: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn()
  },
  disputeEvidence: {
    create: jest.fn()
  },
  riskEvent: {
    findMany: jest.fn(),
    count: jest.fn()
  },
  riskCase: {
    findMany: jest.fn(),
    count: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn()
  },
  ledgerAccount: {
    findMany: jest.fn()
  },
  ledgerEntry: {
    aggregate: jest.fn()
  },
  userSession: {
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn()
  },
  securityEvent: {
    create: jest.fn()
  }
};

jest.unstable_mockModule('../../../utils/db.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.unstable_mockModule('../../withdrawal/service.js', () => ({
  WithdrawalService: jest.fn().mockImplementation(() => ({
    listAllWithdrawals: jest.fn(),
    approveWithdrawal: jest.fn(),
    beginPayout: jest.fn(),
    reportPayoutResult: jest.fn(),
    rejectWithdrawal: jest.fn()
  })),
  WithdrawalNotFoundError: class WithdrawalNotFoundError extends Error {
    constructor(message) {
      super(message);
      this.name = 'WithdrawalNotFoundError';
    }
  },
  WithdrawalStateError: class WithdrawalStateError extends Error {
    constructor(message) {
      super(message);
      this.name = 'WithdrawalStateError';
    }
  },
  BankAccountRequiredError: class BankAccountRequiredError extends Error {
    constructor(message) {
      super(message);
      this.name = 'BankAccountRequiredError';
    }
  },
  PaymentGatewayError: class PaymentGatewayError extends Error {
    constructor(message) {
      super(message);
      this.name = 'PaymentGatewayError';
    }
  }
}));
jest.unstable_mockModule('../../verification/service.js', () => ({
  listVerificationCases: jest.fn(),
  approveVerificationCase: jest.fn(),
  rejectVerificationCase: jest.fn(),
  KYC_STATUSES: ['STARTED', 'PENDING', 'UNDER_REVIEW', 'REJECTED', 'EXPIRED', 'VERIFIED'],
  VerificationCaseNotFoundError: class VerificationCaseNotFoundError extends Error {
    constructor(message) {
      super(message);
      this.name = 'VerificationCaseNotFoundError';
    }
  },
  VerificationCaseNotReviewableError: class VerificationCaseNotReviewableError extends Error {
    constructor(message) {
      super(message);
      this.name = 'VerificationCaseNotReviewableError';
    }
  }
}));
jest.unstable_mockModule('../../saferPlay/service.js', () => ({
  clearTimeoutByAdmin: jest.fn(),
  endSelfExclusionByAdmin: jest.fn()
}));
jest.unstable_mockModule('../../audit/service.js', () => ({
  recordAdminAction: jest.fn().mockResolvedValue({ id: 'log-1' }),
  listAdminActions: jest.fn().mockResolvedValue({ logs: [], total: 0, page: 1, totalPages: 0 }),
  auditPagination: jest.fn(() => ({ page: 1, limit: 20 })),
  AUDIT_OUTCOMES: ['SUCCESS', 'FAILURE', 'DENIED']
}));

const { default: express } = await import('express');
const { default: request } = await import('supertest');
const { adminRouter } = await import('../controller.js');
const { AuthService } = await import('../../auth/service.js');

const app = express();
app.use(express.json());
app.use('/api/v1/admin', adminRouter);
app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
});

const mockRedis = { set: jest.fn(), get: jest.fn(), del: jest.fn(), scanStream: jest.fn() };
mockRedis.get.mockResolvedValue('ng');

const auditModule = await import('../../audit/service.js');
const verificationModule = await import('../../verification/service.js');
const saferPlayModule = await import('../../saferPlay/service.js');
const { WithdrawalService } = await import('../../withdrawal/service.js');
// The controller builds its own singleton during module load; hold a stable
// reference because per-test mocks are cleared in beforeEach.
const controllerWithdrawal = WithdrawalService.mock.results[0].value;

AuthService.__setPrisma(mockPrisma);
AuthService.__setRedis(mockRedis);

const adminUser = { id: 'caller', email: 'admin@x', tier: 'unverified', isBanned: false, isAdmin: true };

const asRole = async (name) => {
  mockPrisma.adminRoleAssignment.findMany.mockResolvedValue([{ role: { name } }]);
  return (await AuthService.issueTokens('caller')).accessToken;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.user.findUnique.mockResolvedValue(adminUser);
  mockPrisma.adminRoleAssignment.findMany.mockResolvedValue([]);
  mockPrisma.adminRoleAssignment.groupBy.mockResolvedValue([]);
  mockPrisma.user.findMany.mockResolvedValue([]);
  mockPrisma.disputeCase.findMany.mockResolvedValue([]);
  mockPrisma.disputeCase.count.mockResolvedValue(0);
  mockPrisma.riskEvent.findMany.mockResolvedValue([]);
  mockPrisma.riskEvent.count.mockResolvedValue(0);
  mockPrisma.riskCase.findMany.mockResolvedValue([]);
  mockPrisma.riskCase.count.mockResolvedValue(0);
  verificationModule.approveVerificationCase.mockResolvedValue(null);
  verificationModule.rejectVerificationCase.mockResolvedValue(null);
  saferPlayModule.clearTimeoutByAdmin.mockResolvedValue(null);
  saferPlayModule.endSelfExclusionByAdmin.mockResolvedValue(null);
});

describe('admin RBAC gating', () => {
  it('denies a caller with no roles and audits the denial', async () => {
    const token = (await AuthService.issueTokens('caller')).accessToken;

    const res = await request(app)
      .get('/api/v1/admin/withdrawals')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient admin permission');
    expect(auditModule.recordAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'permission.denied:withdrawals.read', outcome: 'DENIED' })
    );
  });

  it('lets a READ_ONLY_AUDITOR list but not process withdrawals', async () => {
    const token = await asRole('READ_ONLY_AUDITOR');
    controllerWithdrawal.listAllWithdrawals.mockResolvedValue({ withdrawals: [], total: 0, page: 1, totalPages: 0 });

    const list = await request(app).get('/api/v1/admin/withdrawals').set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);

    const approve = await request(app)
      .post('/api/v1/admin/withdrawals/wd-1/approve')
      .set('Authorization', `Bearer ${token}`);
    expect(approve.status).toBe(403);
  });

  it('lets FINANCE approve a withdrawal and writes a SUCCESS audit row', async () => {
    const token = await asRole('FINANCE');
    controllerWithdrawal.approveWithdrawal.mockResolvedValue({ id: 'wd-1', status: 'APPROVED' });

    const res = await request(app)
      .post('/api/v1/admin/withdrawals/wd-1/approve')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.withdrawal.status).toBe('APPROVED');
    expect(auditModule.recordAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'withdrawal.approve', targetType: 'withdrawal', targetId: 'wd-1' })
    );
  });

  it('keeps role grants exclusive to SUPER_ADMIN', async () => {
    const token = await asRole('FINANCE');
    const res = await request(app)
      .post('/api/v1/admin/roles/assign')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 'u9', roleName: 'SUPPORT' });
    expect(res.status).toBe(403);
  });
});

describe('admin roles routes', () => {
  it('lists the six roles with their permission lenses', async () => {
    const token = await asRole('SUPER_ADMIN');
    const res = await request(app).get('/api/v1/admin/roles').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.roles.map((r) => r.name)).toEqual([
      'SUPER_ADMIN',
      'FINANCE',
      'RISK_COMPLIANCE',
      'SUPPORT',
      'GAME_OPERATIONS',
      'READ_ONLY_AUDITOR'
    ]);
    expect(res.body.roles.find((r) => r.name === 'FINANCE').permissions).toContain('withdrawals.process');
    expect(res.body.roles.find((r) => r.name === 'SUPPORT').permissions).not.toContain('roles.admin');
  });

  it('assigns a role to an existing user with an audit row', async () => {
    const token = await asRole('SUPER_ADMIN');
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(adminUser)
      .mockResolvedValueOnce({ id: 'u9' });
    mockPrisma.adminRole.upsert = jest.fn().mockResolvedValue({ id: 'r2', name: 'SUPPORT' });
    mockPrisma.adminRole.findUniqueOrThrow.mockResolvedValue({ id: 'r2', name: 'SUPPORT' });
    mockPrisma.adminRoleAssignment.upsert = jest.fn().mockResolvedValue({ id: 'asn-1' });

    const res = await request(app)
      .post('/api/v1/admin/roles/assign')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 'u9', roleName: 'SUPPORT' });

    expect(res.status).toBe(201);
    expect(res.body.roleName).toBe('SUPPORT');
    expect(auditModule.recordAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'role.assign', targetId: 'u9' })
    );
  });

  it('rejects assigning an unknown role', async () => {
    const token = await asRole('SUPER_ADMIN');
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(adminUser)
      .mockResolvedValueOnce({ id: 'u9' });

    const res = await request(app)
      .post('/api/v1/admin/roles/assign')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 'u9', roleName: 'OVERLORD' });

    expect(res.status).toBe(400);
  });
});

describe('admin ledger adjustments', () => {
  it('rejects a missing reference and a bad direction', async () => {
    const token = await asRole('FINANCE');
    const missing = await request(app)
      .post('/api/v1/admin/ledger/adjustments')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 'u1', amountMinorUnits: '1000', direction: 'CREDIT' });
    expect(missing.status).toBe(400);

    const badDir = await request(app)
      .post('/api/v1/admin/ledger/adjustments')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 'u1', amountMinorUnits: '1000', direction: 'SIDEWAYS', reference: 'r-1' });
    expect(badDir.status).toBe(400);
  });

  it('maps an overdraft to 422 while leaving the books untouched', async () => {
    const token = await asRole('FINANCE');
    mockPrisma.user.findUnique
      .mockResolvedValueOnce(adminUser)
      .mockResolvedValueOnce({ id: 'u1' });

    const { AdminService } = await import('../service.js');
    jest
      .spyOn(AdminService, 'postAdjustment')
      .mockRejectedValueOnce({ name: 'InsufficientFundsError', message: 'Insufficient funds' });

    const res = await request(app)
      .post('/api/v1/admin/ledger/adjustments')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 'u1', amountMinorUnits: '1000', direction: 'DEBIT', reference: 'r-9' });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Insufficient funds');
  });
});

describe('admin KYC review', () => {
  it('approves a case, audits and reports the result', async () => {
    const token = await asRole('RISK_COMPLIANCE');
    verificationModule.approveVerificationCase.mockResolvedValue({
      case: { id: 'vc-1', status: 'VERIFIED' },
      replayed: false
    });

    const res = await request(app)
      .post('/api/v1/admin/verification-cases/vc-1/approve')
      .set('Authorization', `Bearer ${token}`)
      .send({ note: 'documents match' });

    expect(res.status).toBe(200);
    expect(res.body.verificationCase.status).toBe('VERIFIED');
    expect(verificationModule.approveVerificationCase).toHaveBeenCalledWith(
      'vc-1',
      expect.objectContaining({ adminId: 'caller' })
    );
    expect(auditModule.recordAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'verification.approve', targetId: 'vc-1' })
    );
  });

  it('maps not-found and non-reviewable errors to 404 and 409', async () => {
    const token = await asRole('RISK_COMPLIANCE');
    verificationModule.approveVerificationCase
      .mockRejectedValueOnce({ name: 'VerificationCaseNotFoundError', message: 'Verification case not found' });

    const notFound = await request(app)
      .post('/api/v1/admin/verification-cases/nope/approve')
      .set('Authorization', `Bearer ${token}`);
    expect(notFound.status).toBe(404);

    verificationModule.approveVerificationCase
      .mockRejectedValueOnce({ name: 'VerificationCaseNotReviewableError', message: 'Locked' });
    const locked = await request(app)
      .post('/api/v1/admin/verification-cases/x/approve')
      .set('Authorization', `Bearer ${token}`);
    expect(locked.status).toBe(409);
  });

  it('rejects a case with a default reason when none is supplied', async () => {
    const token = await asRole('RISK_COMPLIANCE');
    verificationModule.rejectVerificationCase.mockResolvedValue({
      case: { id: 'vc-2', status: 'REJECTED' },
      replayed: false
    });

    const res = await request(app)
      .post('/api/v1/admin/verification-cases/vc-2/reject')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(verificationModule.rejectVerificationCase).toHaveBeenCalledWith(
      'vc-2',
      expect.objectContaining({ reason: 'Rejected by operator' })
    );
  });
});

describe('admin disputes', () => {
  it('lists disputes resolving raiser emails', async () => {
    const token = await asRole('SUPPORT');
    mockPrisma.disputeCase.findMany.mockResolvedValue([
      { id: 'd1', raisedBy: 'u-raiser', evidence: [], match: null }
    ]);
    mockPrisma.disputeCase.count.mockResolvedValue(1);
    mockPrisma.user.findMany.mockResolvedValue([{ id: 'u-raiser', email: 'raiser@x' }]);

    const res = await request(app).get('/api/v1/admin/disputes').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.disputes[0].raisedByEmail).toBe('raiser@x');
  });

  it('decides an open dispute with an audit row', async () => {
    const token = await asRole('SUPPORT');
    mockPrisma.disputeCase.findUnique.mockResolvedValue({ id: 'd1', status: 'OPEN' });
    mockPrisma.disputeCase.update.mockResolvedValue({ id: 'd1', status: 'RESOLVED', decidedBy: 'caller' });

    const res = await request(app)
      .post('/api/v1/admin/disputes/d1/decide')
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'RESOLVED', resolution: 'Refund issued' });

    expect(res.status).toBe(200);
    expect(mockPrisma.disputeCase.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: expect.objectContaining({ status: 'RESOLVED', decidedBy: 'caller', decidedAt: expect.any(Date) })
    });
    expect(auditModule.recordAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'dispute.decide' })
    );
  });

  it('refuses to re-decide a closed dispute', async () => {
    const token = await asRole('SUPPORT');
    mockPrisma.disputeCase.findUnique.mockResolvedValue({ id: 'd1', status: 'RESOLVED' });

    const res = await request(app)
      .post('/api/v1/admin/disputes/d1/decide')
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'RESOLVED', resolution: 'Again' });

    expect(res.status).toBe(409);
    expect(mockPrisma.disputeCase.update).not.toHaveBeenCalled();
  });

  it('requires a legal evidence type before attaching', async () => {
    const token = await asRole('SUPPORT');
    const res = await request(app)
      .post('/api/v1/admin/disputes/d1/evidence')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'MOVIE', url: 'https://example.com/x.png' });
    expect(res.status).toBe(400);
  });
});

describe('admin safer-play lifts', () => {
  it('clears a timeout but 404s a missing user first', async () => {
    const token = await asRole('SUPPORT');
    mockPrisma.user.findUnique.mockResolvedValueOnce(adminUser).mockResolvedValueOnce({ id: 'u1' });
    saferPlayModule.clearTimeoutByAdmin.mockResolvedValue({ userId: 'u1', timeoutUntil: null });

    const res = await request(app)
      .post('/api/v1/admin/safer-play/u1/clear-timeout')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.lifted).toBe(true);

    mockPrisma.user.findUnique.mockResolvedValueOnce(adminUser).mockResolvedValueOnce(null);
    const missing = await request(app)
      .post('/api/v1/admin/safer-play/ghost/clear-timeout')
      .set('Authorization', `Bearer ${token}`);
    expect(missing.status).toBe(404);
  });
});

describe('admin risk review', () => {
  it('lets RISK_COMPLIANCE read risk events but keeps SUPPORT out', async () => {
    const riskToken = await asRole('RISK_COMPLIANCE');
    const ok = await request(app).get('/api/v1/admin/risk-events').set('Authorization', `Bearer ${riskToken}`);
    expect(ok.status).toBe(200);

    const supportToken = await asRole('SUPPORT');
    const denied = await request(app).get('/api/v1/admin/risk-events').set('Authorization', `Bearer ${supportToken}`);
    expect(denied.status).toBe(403);
  });

  it('rejects an unknown risk case status', async () => {
    const token = await asRole('RISK_COMPLIANCE');
    const res = await request(app)
      .post('/api/v1/admin/risk-cases/rc-1/status')
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'EXPLODED' });
    expect(res.status).toBe(400);
  });
});