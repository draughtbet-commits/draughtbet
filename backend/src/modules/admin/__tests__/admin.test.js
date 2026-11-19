import { jest } from '@jest/globals';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.REDIS_URL = '';
// auth/service.js loads dotenv at import time; pin the JWT secret up front so
// middleware and token signing agree regardless of import ordering.
process.env.JWT_SECRET = 'unittest-admin-secret';

const mockPrisma = {
  $transaction: jest.fn(),
  $queryRaw: jest.fn().mockResolvedValue([{ id: 'la-1' }]),
  user: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    count: jest.fn()
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
    findMany: jest.fn(),
    upsert: jest.fn()
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
  },
  match: {
    findMany: jest.fn(),
    count: jest.fn()
  },
  adminAuditLog: {
    findMany: jest.fn(),
    count: jest.fn()
  },
  verificationCase: {
    count: jest.fn(),
    findMany: jest.fn()
  },
  withdrawal: {
    count: jest.fn(),
    aggregate: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn()
  },
  supportCase: {
    findMany: jest.fn(),
    count: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn()
  },
  supportCaseNote: {
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
    getWithdrawal: jest.fn(),
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
  getVerificationCaseDetail: jest.fn(),
  generateVerificationDocumentAccess: jest.fn(),
  requestAdditionalKycInfo: jest.fn(),
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
  endSelfExclusionByAdmin: jest.fn(),
  applyAdminSaferPlayRestriction: jest.fn(),
  listSaferPlayRestrictions: jest.fn()
}));
jest.unstable_mockModule('../../audit/service.js', () => ({
  recordAdminAction: jest.fn().mockResolvedValue({ id: 'log-1' }),
  listAdminActions: jest.fn().mockResolvedValue({ logs: [], total: 0, page: 1, totalPages: 0 }),
  getAdminActionDetail: jest.fn().mockResolvedValue({ id: 'log-1', action: 'test' }),
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
  mockPrisma.user.count.mockResolvedValue(0);
  mockPrisma.match.count.mockResolvedValue(0);
  mockPrisma.match.findMany.mockResolvedValue([]);
  mockPrisma.verificationCase.count.mockResolvedValue(0);
  mockPrisma.verificationCase.findMany.mockResolvedValue([]);
  mockPrisma.withdrawal.count.mockResolvedValue(0);
  mockPrisma.withdrawal.aggregate.mockResolvedValue({ _sum: { amountMinorUnits: 0n } });
  mockPrisma.withdrawal.findMany.mockResolvedValue([]);
  mockPrisma.withdrawal.findFirst.mockResolvedValue(null);
  mockPrisma.supportCase.findMany.mockResolvedValue([]);
  mockPrisma.supportCase.count.mockResolvedValue(0);
  mockPrisma.supportCase.findFirst.mockResolvedValue(null);
  mockPrisma.adminAuditLog.findMany.mockResolvedValue([]);
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

describe('admin dashboard summary (Module A)', () => {
  it('returns operational counts and masks financials for SUPPORT', async () => {
    mockPrisma.user.count.mockResolvedValueOnce(50).mockResolvedValueOnce(45).mockResolvedValueOnce(5);
    mockPrisma.match.count.mockResolvedValueOnce(100).mockResolvedValueOnce(10).mockResolvedValueOnce(90);
    mockPrisma.disputeCase.count.mockResolvedValueOnce(2);
    mockPrisma.verificationCase.count.mockResolvedValueOnce(4);
    mockPrisma.riskCase.count.mockResolvedValueOnce(1);
    mockPrisma.adminAuditLog.findMany.mockResolvedValueOnce([]);

    const token = await asRole('SUPPORT');
    const res = await request(app)
      .get('/api/v1/admin/dashboard/summary')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.summary.players.total).toBe(50);
    expect(res.body.summary.matches.total).toBe(100);
    expect(res.body.summary.compliance.pendingKyc).toBe(4);
    expect(res.body.summary.financials).toBeNull();
  });

  it('includes financial totals when accessed by FINANCE', async () => {
    mockPrisma.user.count.mockResolvedValueOnce(50).mockResolvedValueOnce(45).mockResolvedValueOnce(5);
    mockPrisma.match.count.mockResolvedValueOnce(100).mockResolvedValueOnce(10).mockResolvedValueOnce(90);
    mockPrisma.disputeCase.count.mockResolvedValueOnce(2);
    mockPrisma.verificationCase.count.mockResolvedValueOnce(4);
    mockPrisma.riskCase.count.mockResolvedValueOnce(1);
    mockPrisma.adminAuditLog.findMany.mockResolvedValueOnce([]);
    mockPrisma.withdrawal.count.mockResolvedValueOnce(3).mockResolvedValueOnce(15);
    mockPrisma.withdrawal.aggregate
      .mockResolvedValueOnce({ _sum: { amountMinorUnits: 300000n } })
      .mockResolvedValueOnce({ _sum: { amountMinorUnits: 1500000n } });

    const token = await asRole('FINANCE');
    const res = await request(app)
      .get('/api/v1/admin/dashboard/summary')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.summary.financials).not.toBeNull();
    expect(res.body.summary.financials.pendingWithdrawalsCount).toBe(3);
    expect(res.body.summary.financials.pendingWithdrawalsAmountMinorUnits).toBe('300000');
    expect(res.body.summary.financials.currency).toBe('NGN');
  });

  it('denies dashboard summary to a non-admin account', async () => {
    mockPrisma.adminRoleAssignment.findMany.mockResolvedValue([]);
    const { accessToken } = await AuthService.issueTokens('regular-player-1');
    const res = await request(app)
      .get('/api/v1/admin/dashboard/summary')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Account does not have admin privileges');
  });
});

describe('admin player management (Module B)', () => {
  it('lists players with search and pagination for any admin role', async () => {
    mockPrisma.user.findMany.mockResolvedValueOnce([
      { id: 'u1', email: 'p1@test.com', username: 'player1', tier: 'AMATEUR', kycStatus: 'VERIFIED', isBanned: false, createdAt: new Date() }
    ]);
    mockPrisma.user.count.mockResolvedValueOnce(1);

    const token = await asRole('SUPPORT');
    const res = await request(app)
      .get('/api/v1/admin/users?page=1&limit=10&search=player1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(1);
    expect(res.body.total).toBe(1);
    expect(res.body.page).toBe(1);
  });

  it('returns player details with safe fields', async () => {
    mockPrisma.user.findUnique.mockImplementation(async ({ where }) => {
      if (where.id === 'caller') return adminUser;
      if (where.id === 'target-1') {
        return {
          id: 'target-1',
          email: 'target@test.com',
          username: 'targetPlayer',
          phone: '+2348011111111',
          kycStatus: 'VERIFIED',
          isBanned: false,
          isAdmin: false,
          createdAt: new Date(),
          saferPlayProfile: null,
          saferPlayEvents: [],
          verificationCases: [],
          sessions: [],
          devices: []
        };
      }
      return null;
    });

    const token = await asRole('SUPPORT');
    const res = await request(app)
      .get('/api/v1/admin/users/target-1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('target@test.com');
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(res.body.user.financials).toBeNull();
  });

  it('returns 404 when player does not exist', async () => {
    mockPrisma.user.findUnique.mockImplementation(async ({ where }) => {
      if (where.id === 'caller') return adminUser;
      return null;
    });

    const token = await asRole('SUPPORT');
    const res = await request(app)
      .get('/api/v1/admin/users/non-existent-user')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it('stores a newly registered player and retrieves them immediately in the admin directory without excluding KYC NONE accounts', async () => {
    const store = [];
    mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
    mockPrisma.$queryRaw.mockResolvedValue([{ id: 'la-1' }]);
    mockPrisma.user.create.mockImplementation(async ({ data }) => {
      const created = {
        id: 'new-player-1',
        email: data.email,
        phone: data.phone,
        username: data.username,
        fullName: data.fullName,
        tier: 'AMATEUR',
        kycStatus: 'NONE',
        ageVerified: data.ageVerified,
        countryCode: data.countryCode,
        isBanned: data.isBanned,
        isAdmin: false,
        createdAt: new Date(),
        wallet: { id: 'wal-1', currency: 'NGN' }
      };
      store.unshift(created);
      return created;
    });

    mockRedis.get.mockResolvedValueOnce('NG');
    const registered = await AuthService.register({
      email: 'NewPlayer@Example.com',
      phone: '08012345678',
      username: 'newbie_draught',
      fullName: 'New Draught Player',
      address: '12 Marina Road, Lagos',
      password: 'Password123',
      dateOfBirth: '1998-05-15',
      fingerprintHash: 'fp-1',
      countryCode: 'NG',
      geoBinding: 'geo-bind-123456'
    });

    // 1. Newly registered player stored with normalized email and unverified KYC status (NONE)
    expect(registered.id).toBe('new-player-1');
    expect(registered.email).toBe('newplayer@example.com');
    expect(registered.kycStatus).toBe('NONE');
    expect(registered.isBanned).toBe(false);

    // 2 & 3 & 4. Admin directory retrieves the unverified newly registered player on page 1 sorted newest-first
    mockPrisma.user.findMany.mockImplementation(async ({ where, orderBy }) => {
      expect(where).toEqual({});
      expect(orderBy).toEqual({ createdAt: 'desc' });
      return store;
    });
    mockPrisma.user.count.mockImplementation(async () => store.length);

    const token = await asRole('SUPER_ADMIN');
    const dirRes = await request(app)
      .get('/api/v1/admin/users?page=1&limit=15')
      .set('Authorization', `Bearer ${token}`);

    expect(dirRes.status).toBe(200);
    expect(dirRes.body.users).toHaveLength(1);
    expect(dirRes.body.users[0].id).toBe('new-player-1');
    expect(dirRes.body.users[0].email).toBe('newplayer@example.com');
    expect(dirRes.body.users[0].kycStatus).toBe('NONE');
    expect(dirRes.body.total).toBe(1);
    expect(dirRes.body.totalPages).toBe(1);
  });

  it('locates newly registered players via search across email, username, fullName, phone, displayName, and id', async () => {
    const newPlayer = {
      id: 'new-player-2',
      email: 'chukwu@draughtbet.com',
      username: 'chukwu_king',
      fullName: 'Chukwuemeka Obi',
      phone: '+2348099887766',
      tier: 'AMATEUR',
      kycStatus: 'NONE',
      ageVerified: true,
      countryCode: 'NG',
      isBanned: false,
      isAdmin: false,
      createdAt: new Date()
    };
    mockPrisma.user.findMany.mockResolvedValueOnce([newPlayer]);
    mockPrisma.user.count.mockResolvedValueOnce(1);

    const token = await asRole('GAME_OPERATIONS');
    const res = await request(app)
      .get('/api/v1/admin/users?page=1&limit=15&search=chukwu_king')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0].username).toBe('chukwu_king');
    expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { id: { contains: 'chukwu_king', mode: 'insensitive' } },
            { email: { contains: 'chukwu_king', mode: 'insensitive' } },
            { username: { contains: 'chukwu_king', mode: 'insensitive' } },
            { fullName: { contains: 'chukwu_king', mode: 'insensitive' } },
            { displayName: { contains: 'chukwu_king', mode: 'insensitive' } },
            { phone: { contains: 'chukwu_king', mode: 'insensitive' } }
          ]
        }
      })
    );
  });

  it('enforces suspension, KYC, and unauthorized access boundaries on the player directory', async () => {
    // 6. Unauthorized non-admin player is denied (403)
    mockPrisma.adminRoleAssignment.findMany.mockResolvedValueOnce([]);
    const { accessToken: playerToken } = await AuthService.issueTokens('regular-player-99');
    const deniedRes = await request(app)
      .get('/api/v1/admin/users')
      .set('Authorization', `Bearer ${playerToken}`);
    expect(deniedRes.status).toBe(403);

    // 7. Existing suspension (isBanned) and KYC (kycStatus) filters pass accurate predicates
    const adminToken = await asRole('RISK_COMPLIANCE');
    mockPrisma.user.findMany.mockResolvedValueOnce([]);
    mockPrisma.user.count.mockResolvedValueOnce(0);

    const filteredRes = await request(app)
      .get('/api/v1/admin/users?page=1&limit=15&isBanned=false&kycStatus=NONE')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(filteredRes.status).toBe(200);
    expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isBanned: false, kycStatus: 'NONE' }
      })
    );
  });
});

describe('admin withdrawal details (Module C)', () => {
  it('returns withdrawal detail with audit history for FINANCE', async () => {
    controllerWithdrawal.getWithdrawal.mockResolvedValueOnce({
      id: 'wd-detail-1',
      userId: 'u-1',
      amountMinorUnits: '50000',
      currency: 'NGN',
      reference: 'REF-WD-1',
      gateway: 'PAYSTACK',
      status: 'PENDING_REVIEW',
      user: { id: 'u-1', email: 'u1@test.com' },
      bankAccount: { bankName: 'Access Bank', accountNumber: '0123456789' }
    });
    mockPrisma.adminAuditLog.findMany.mockResolvedValueOnce([
      { id: 'audit-1', action: 'withdrawal.approve', outcome: 'SUCCESS', createdAt: new Date() }
    ]);

    const token = await asRole('FINANCE');
    const res = await request(app)
      .get('/api/v1/admin/withdrawals/wd-detail-1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.withdrawal.id).toBe('wd-detail-1');
    expect(res.body.withdrawal.bankAccount.bankName).toBe('Access Bank');
    expect(res.body.withdrawal.auditHistory).toHaveLength(1);
  });

  it('rejects withdrawal detail request if role lacks withdrawals.read (e.g. SUPPORT)', async () => {
    const token = await asRole('SUPPORT');
    const res = await request(app)
      .get('/api/v1/admin/withdrawals/wd-detail-1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient admin permission');
  });
});

describe('admin support cases (Module D)', () => {
  it('returns a valid 200 empty response when there are no support cases', async () => {
    mockPrisma.supportCase.findMany.mockResolvedValueOnce([]);
    mockPrisma.supportCase.count.mockResolvedValueOnce(0);

    const token = await asRole('SUPPORT');
    const res = await request(app)
      .get('/api/v1/admin/support/cases?page=1&limit=10')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.cases).toEqual([]);
    expect(res.body.total).toBe(0);
    expect(res.body.page).toBe(1);
    expect(res.body.totalPages).toBe(1);
  });

  it('lists existing support cases and handles pagination, empty search, and null optional relations', async () => {
    const token = await asRole('SUPPORT');

    // 1. Existing cases including one with null optional user/notes relations
    mockPrisma.supportCase.findMany.mockResolvedValueOnce([
      {
        id: 'sc-1',
        reference: 'SUP-1001',
        userId: 'u-1',
        subject: 'Deposit delay',
        description: 'Transfer pending',
        category: 'DEPOSIT',
        priority: 'HIGH',
        status: 'OPEN',
        user: null,
        notes: null,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ]);
    mockPrisma.supportCase.count.mockResolvedValueOnce(11);

    const listRes = await request(app)
      .get('/api/v1/admin/support/cases?page=1&limit=10')
      .set('Authorization', `Bearer ${token}`);

    expect(listRes.status).toBe(200);
    expect(listRes.body.cases).toHaveLength(1);
    expect(listRes.body.cases[0].user).toBeNull();
    expect(listRes.body.cases[0].notes).toEqual([]);
    expect(listRes.body.total).toBe(11);
    expect(listRes.body.totalPages).toBe(2);

    // 2. Last page and empty page beyond results
    mockPrisma.supportCase.findMany.mockResolvedValueOnce([]);
    mockPrisma.supportCase.count.mockResolvedValueOnce(11);

    const emptyPageRes = await request(app)
      .get('/api/v1/admin/support/cases?page=3&limit=10')
      .set('Authorization', `Bearer ${token}`);

    expect(emptyPageRes.status).toBe(200);
    expect(emptyPageRes.body.cases).toEqual([]);
    expect(emptyPageRes.body.page).toBe(3);
    expect(emptyPageRes.body.totalPages).toBe(2);

    // 3. Search returning no matches
    mockPrisma.supportCase.findMany.mockResolvedValueOnce([]);
    mockPrisma.supportCase.count.mockResolvedValueOnce(0);

    const noMatchRes = await request(app)
      .get('/api/v1/admin/support/cases?page=1&limit=10&search=nonexistent_ref')
      .set('Authorization', `Bearer ${token}`);

    expect(noMatchRes.status).toBe(200);
    expect(noMatchRes.body.cases).toEqual([]);
    expect(noMatchRes.body.total).toBe(0);
    expect(noMatchRes.body.totalPages).toBe(1);
  });

  it('retrieves support case detail when optional relations are null', async () => {
    const token = await asRole('SUPPORT');
    mockPrisma.supportCase.findFirst.mockResolvedValueOnce({
      id: 'sc-1',
      reference: 'SUP-1001',
      userId: 'u-1',
      subject: 'Account inquiry',
      description: 'Need help',
      category: 'ACCOUNT',
      priority: 'MEDIUM',
      status: 'OPEN',
      relatedMatchId: null,
      relatedTransactionRef: null,
      user: null,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    mockPrisma.adminAuditLog.findMany.mockResolvedValueOnce([]);

    const detailRes = await request(app)
      .get('/api/v1/admin/support/cases/sc-1')
      .set('Authorization', `Bearer ${token}`);

    expect(detailRes.status).toBe(200);
    expect(detailRes.body.supportCase.id).toBe('sc-1');
    expect(detailRes.body.supportCase.user).toBeNull();
    expect(detailRes.body.supportCase.notes).toEqual([]);
    expect(detailRes.body.supportCase.relatedMatch).toBeNull();
    expect(detailRes.body.supportCase.relatedWithdrawal).toBeNull();
  });
});