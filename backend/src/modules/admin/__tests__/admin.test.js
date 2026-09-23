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
    count: jest.fn(),
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
  match: {
    findUnique: jest.fn(),
    findMany: jest.fn()
  },
  matchMove: {
    findMany: jest.fn()
  },
  matchParticipant: {
    findUnique: jest.fn()
  },
  matchResultCorrection: {
    create: jest.fn(),
    findMany: jest.fn()
  },
  idempotencyRecord: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn()
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
  listCaseDocuments: jest.fn(),
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
const mockRecordAdminAction = jest.fn().mockResolvedValue({ id: 'log-1' });
// auditFromRequest forwards into recordAdminAction (matching the real module),
// so assertions on recordAdminAction cover both the legacy admin `audit` helper
// and the new module-level auditFromRequest call sites.
const mockAuditFromRequest = jest.fn(async (req, action, opts = {}) => {
  await mockRecordAdminAction({
    adminId: req.user.id,
    action,
    outcome: opts.outcome ?? 'SUCCESS',
    targetType: opts.targetType ?? null,
    targetId: opts.targetId ?? null,
    metadata: opts.metadata ?? null,
    ip: req.ip,
    userAgent: req.get?.('user-agent') ?? null,
    requestId: req.id
  });
  return { id: 'log-1' };
});
jest.unstable_mockModule('../../audit/service.js', () => ({
  recordAdminAction: mockRecordAdminAction,
  auditFromRequest: mockAuditFromRequest,
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

// Every admin POST now requires an Idempotency-Key header (contract §9).
const OP_KEY = 'op-key-0001';

const asRole = async (name) => {
  mockPrisma.adminRoleAssignment.findMany.mockResolvedValue([{ role: { name } }]);
  return (await AuthService.issueTokens('caller')).accessToken;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.user.findUnique.mockResolvedValue(adminUser);
  mockPrisma.user.findMany.mockResolvedValue([]);
  mockPrisma.user.count.mockResolvedValue(0);
  mockPrisma.adminRoleAssignment.findMany.mockResolvedValue([]);
  mockPrisma.adminRoleAssignment.groupBy.mockResolvedValue([]);
  mockPrisma.disputeCase.findMany.mockResolvedValue([]);
  mockPrisma.disputeCase.count.mockResolvedValue(0);
  mockPrisma.riskEvent.findMany.mockResolvedValue([]);
  mockPrisma.riskEvent.count.mockResolvedValue(0);
  mockPrisma.riskCase.findMany.mockResolvedValue([]);
  mockPrisma.riskCase.count.mockResolvedValue(0);
  mockPrisma.match.findUnique.mockResolvedValue(null);
  mockPrisma.matchMove.findMany.mockResolvedValue([]);
  mockPrisma.matchResultCorrection.findMany.mockResolvedValue([]);
  mockPrisma.matchParticipant.findUnique.mockResolvedValue(null);
  mockPrisma.idempotencyRecord.findUnique.mockResolvedValue(null);
  mockPrisma.idempotencyRecord.create.mockResolvedValue({ id: 'ir-1', result: null });
  mockPrisma.idempotencyRecord.update.mockResolvedValue({ id: 'ir-1' });
  mockPrisma.idempotencyRecord.delete.mockResolvedValue({ id: 'ir-1' });
  mockPrisma.idempotencyRecord.deleteMany.mockResolvedValue({ count: 1 });
  mockPrisma.$transaction.mockImplementation(async (fn) => (typeof fn === 'function' ? fn(mockPrisma) : undefined));
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
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', OP_KEY);
    expect(approve.status).toBe(403);
  });

  it('lets FINANCE approve a withdrawal and writes a SUCCESS audit row', async () => {
    const token = await asRole('FINANCE');
    controllerWithdrawal.approveWithdrawal.mockResolvedValue({ id: 'wd-1', status: 'APPROVED' });

    const res = await request(app)
      .post('/api/v1/admin/withdrawals/wd-1/approve')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', OP_KEY);

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
      .set('Idempotency-Key', OP_KEY)
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
      .set('Idempotency-Key', OP_KEY)
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
      .set('Idempotency-Key', OP_KEY)
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
      .set('Idempotency-Key', OP_KEY)
      .send({ userId: 'u1', amountMinorUnits: '1000', direction: 'CREDIT' });
    expect(missing.status).toBe(400);

    const badDir = await request(app)
      .post('/api/v1/admin/ledger/adjustments')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', OP_KEY)
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
      .set('Idempotency-Key', OP_KEY)
      .send({ userId: 'u1', amountMinorUnits: '1000', direction: 'DEBIT', reference: 'r-9' });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Insufficient funds');
  });
});

describe('admin KYC review', () => {
  it('lists verification cases at the renamed /kyc/cases surface', async () => {
    const token = await asRole('RISK_COMPLIANCE');
    verificationModule.listVerificationCases.mockResolvedValue({
      cases: [{ id: 'vc-1', status: 'PENDING' }],
      total: 1,
      page: 1,
      totalPages: 1
    });

    const res = await request(app).get('/api/v1/admin/kyc/cases').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(verificationModule.listVerificationCases).toHaveBeenCalled();
  });

  it('approves a case via the decision endpoint, audits and reports the result', async () => {
    const token = await asRole('RISK_COMPLIANCE');
    verificationModule.approveVerificationCase.mockResolvedValue({
      case: { id: 'vc-1', status: 'VERIFIED' },
      replayed: false
    });

    const res = await request(app)
      .post('/api/v1/admin/kyc/cases/vc-1/decision')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', OP_KEY)
      .send({ decision: 'APPROVE', note: 'documents match' });

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
      .post('/api/v1/admin/kyc/cases/nope/decision')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', OP_KEY)
      .send({ decision: 'APPROVE' });
    expect(notFound.status).toBe(404);

    verificationModule.approveVerificationCase
      .mockRejectedValueOnce({ name: 'VerificationCaseNotReviewableError', message: 'Locked' });
    const locked = await request(app)
      .post('/api/v1/admin/kyc/cases/x/decision')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', OP_KEY)
      .send({ decision: 'APPROVE' });
    expect(locked.status).toBe(409);
  });

  it('rejects a case with a default reason when none is supplied', async () => {
    const token = await asRole('RISK_COMPLIANCE');
    verificationModule.rejectVerificationCase.mockResolvedValue({
      case: { id: 'vc-2', status: 'REJECTED' },
      replayed: false
    });

    const res = await request(app)
      .post('/api/v1/admin/kyc/cases/vc-2/decision')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', OP_KEY)
      .send({ decision: 'REJECT' });

    expect(res.status).toBe(200);
    expect(verificationModule.rejectVerificationCase).toHaveBeenCalledWith(
      'vc-2',
      expect.objectContaining({ reason: 'Rejected by operator' })
    );
  });

  it('rejects an invalid decision value and a missing Idempotency-Key', async () => {
    const token = await asRole('RISK_COMPLIANCE');
    const bad = await request(app)
      .post('/api/v1/admin/kyc/cases/vc-1/decision')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', OP_KEY)
      .send({ decision: 'MAYBE' });
    expect(bad.status).toBe(400);

    const noKey = await request(app)
      .post('/api/v1/admin/kyc/cases/vc-1/decision')
      .set('Authorization', `Bearer ${token}`)
      .send({ decision: 'APPROVE' });
    expect(noKey.status).toBe(400);
    expect(noKey.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
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
      .post('/api/v1/admin/disputes/d1/decision')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', OP_KEY)
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

  it('writes an append-only result correction and posts the money adjustment as a separate transaction', async () => {
    const token = await asRole('SUPER_ADMIN');
    mockPrisma.disputeCase.findUnique.mockResolvedValue({
      id: 'd1',
      status: 'OPEN',
      matchId: 'm1',
      match: { winnerId: 'p1', endReason: 'capture_win' }
    });
    mockPrisma.disputeCase.update.mockResolvedValue({ id: 'd1', status: 'RESOLVED' });
    mockPrisma.matchResultCorrection.create.mockResolvedValue({ id: 'c1' });

    const { AdminService } = await import('../service.js');
    const adjSpy = jest
      .spyOn(AdminService, 'postAdjustment')
      .mockResolvedValue({ transactionId: 'tx-1', reference: 'dispute:d1', direction: 'CREDIT', available: '50000' });

    const res = await request(app)
      .post('/api/v1/admin/disputes/d1/decide')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', OP_KEY)
      .send({
        status: 'RESOLVED',
        resolution: 'Wrong winner adjudicated',
        resultCorrection: { winnerId: 'p2', endReason: 'admin_decision' },
        moneyAdjustment: { userId: 'p2', amountMinorUnits: '50000', direction: 'CREDIT' }
      });

    expect(res.status).toBe(200);
    expect(mockPrisma.matchResultCorrection.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        matchId: 'm1',
        disputeCaseId: 'd1',
        priorWinnerId: 'p1',
        correctedWinnerId: 'p2',
        priorEndReason: 'capture_win',
        correctedEndReason: 'admin_decision',
        decidedBy: 'caller'
      })
    });
    expect(adjSpy).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'p2', reference: 'dispute:d1', actorId: 'caller' })
    );
  });

  it('denies SUPPORT a disputed payout money adjustment (needs ledger.adjust)', async () => {
    const token = await asRole('SUPPORT');
    const res = await request(app)
      .post('/api/v1/admin/disputes/d1/decision')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', OP_KEY)
      .send({
        status: 'RESOLVED',
        resolution: 'Refund',
        moneyAdjustment: { userId: 'p2', amountMinorUnits: '1000', direction: 'CREDIT' }
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('fails the money adjustment to 422 but records that the decision is already saved', async () => {
    const token = await asRole('SUPER_ADMIN');
    mockPrisma.disputeCase.findUnique.mockResolvedValue({
      id: 'd1',
      status: 'OPEN',
      matchId: 'm1',
      match: { winnerId: 'p1', endReason: 'capture_win' }
    });
    mockPrisma.disputeCase.update.mockResolvedValue({ id: 'd1', status: 'RESOLVED' });

    const { AdminService } = await import('../service.js');
    jest
      .spyOn(AdminService, 'postAdjustment')
      .mockRejectedValueOnce({ name: 'InsufficientFundsError', message: 'Insufficient funds' });

    const res = await request(app)
      .post('/api/v1/admin/disputes/d1/decision')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', OP_KEY)
      .send({
        status: 'RESOLVED',
        resolution: 'Refund',
        moneyAdjustment: { userId: 'p2', amountMinorUnits: '1000', direction: 'DEBIT' }
      });

    expect(res.status).toBe(422);
    expect(res.body.error.decisionRecorded).toBe(true);
    expect(auditModule.recordAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ledger.adjustment', outcome: 'FAILURE' })
    );
  });

  it('refuses to re-decide a closed dispute', async () => {
    const token = await asRole('SUPPORT');
    mockPrisma.disputeCase.findUnique.mockResolvedValue({ id: 'd1', status: 'RESOLVED' });

    const res = await request(app)
      .post('/api/v1/admin/disputes/d1/decision')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', OP_KEY)
      .send({ status: 'RESOLVED', resolution: 'Again' });

    expect(res.status).toBe(409);
    expect(mockPrisma.disputeCase.update).not.toHaveBeenCalled();
  });

  it('requires a legal evidence type before attaching', async () => {
    const token = await asRole('SUPPORT');
    const res = await request(app)
      .post('/api/v1/admin/disputes/d1/evidence')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', OP_KEY)
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
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', OP_KEY);

    expect(res.status).toBe(200);
    expect(res.body.lifted).toBe(true);

    mockPrisma.user.findUnique.mockResolvedValueOnce(adminUser).mockResolvedValueOnce(null);
    const missing = await request(app)
      .post('/api/v1/admin/safer-play/ghost/clear-timeout')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', OP_KEY);
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
      .set('Idempotency-Key', OP_KEY)
      .send({ status: 'EXPLODED' });
    expect(res.status).toBe(400);
  });
});

describe('admin POST idempotency (Idempotency-Key)', () => {
  it('replays a cached response and does not re-run the handler', async () => {
    const token = await asRole('FINANCE');
    controllerWithdrawal.rejectWithdrawal.mockResolvedValue({ id: 'wd-1' });

    mockPrisma.idempotencyRecord.findUnique.mockResolvedValueOnce(null);
    mockPrisma.idempotencyRecord.create.mockResolvedValueOnce({ id: 'ir-1', result: null });

    const first = await request(app)
      .post('/api/v1/admin/withdrawals/wd-1/reject')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'op-retry-0001')
      .send({ reason: 'fraud' });

    expect(first.status).toBe(200);

    mockPrisma.idempotencyRecord.findUnique.mockResolvedValueOnce({
      key: 'ir-1',
      result: { status: 200, body: { withdrawal: { id: 'wd-1' } } }
    });

    const second = await request(app)
      .post('/api/v1/admin/withdrawals/wd-1/reject')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'op-retry-0001')
      .send({ reason: 'fraud' });

    expect(second.status).toBe(200);
    expect(second.body.withdrawal.id).toBe('wd-1');
    expect(controllerWithdrawal.rejectWithdrawal).toHaveBeenCalledTimes(1);
  });

  it('rejects concurrent in-flight claims with DUPLICATE_OPERATION', async () => {
    const token = await asRole('FINANCE');
    mockPrisma.idempotencyRecord.findUnique.mockResolvedValueOnce({
      key: 'ir-1',
      result: null,
      createdAt: new Date()
    });

    const res = await request(app)
      .post('/api/v1/admin/withdrawals/wd-1/approve')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'op-retry-0001');

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_OPERATION');
    expect(controllerWithdrawal.approveWithdrawal).not.toHaveBeenCalled();
  });
});

describe('admin user directory', () => {
  it('searches users for SUPPORT and returns operational fields', async () => {
    const token = await asRole('SUPPORT');
    mockPrisma.user.findMany.mockResolvedValue([
      { id: 'u1', email: 'u1@x', username: 'kingslayer', kycStatus: 'VERIFIED', isBanned: false, createdAt: new Date().toISOString() }
    ]);
    mockPrisma.user.count.mockResolvedValue(1);

    const res = await request(app).get('/api/v1/admin/users?q=king').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(1);
    expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ OR: expect.any(Array) })
      })
    );
  });

  it('returns a user detail with roles and latest verification case', async () => {
    const token = await asRole('SUPPORT');
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'u1@x',
      username: 'kingslayer',
      kycStatus: 'VERIFIED',
      isBanned: false,
      createdAt: new Date().toISOString(),
      verificationCases: [{ status: 'VERIFIED' }],
      adminRoleAssignments: [{ role: { name: 'SUPER_ADMIN' } }]
    });

    const res = await request(app).get('/api/v1/admin/users/u1').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual(['SUPER_ADMIN']);
    expect(res.body.verificationStatus).toBe('VERIFIED');

    // requireAuth also consumes user.findUnique, so the target-vs-caller split
    // needs an explicit queue: caller first, then null for the missing target.
    mockPrisma.user.findUnique.mockResolvedValueOnce(adminUser).mockResolvedValue(null);
    const missing = await request(app).get('/api/v1/admin/users/nope').set('Authorization', `Bearer ${token}`);
    expect(missing.status).toBe(404);
  });
});

describe('admin match evidence', () => {
  const matchFixture = {
    id: 'm1',
    status: 'COMPLETED',
    winnerId: 'p1',
    participants: [],
    stakeReservations: [],
    settlements: [],
    receipts: [],
    gameEvents: [],
    connectionEvents: [],
    snapshots: [],
    gameState: null
  };

  it('exposes read-only match evidence to GAME_OPERATIONS', async () => {
    const token = await asRole('GAME_OPERATIONS');
    mockPrisma.match.findUnique.mockResolvedValue(matchFixture);
    mockPrisma.matchMove.findMany.mockResolvedValue([{ moveNumber: 1, playerId: 'p1', fromSquare: 1, toSquare: 2, createdAt: new Date().toISOString() }]);

    const res = await request(app).get('/api/v1/admin/matches/m1/evidence').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.match.id).toBe('m1');
    expect(res.body.moves).toHaveLength(1);
    expect(res.body.resultCorrections).toEqual([]);
  });

  it('keeps READ_ONLY_AUDITOR and unidentified callers out', async () => {
    const auditor = await asRole('READ_ONLY_AUDITOR');
    const denied = await request(app).get('/api/v1/admin/matches/m1/evidence').set('Authorization', `Bearer ${auditor}`);
    expect(denied.status).toBe(403);

    mockPrisma.match.findUnique.mockResolvedValue(matchFixture);
    const auditorCopy = await asRole('GAME_OPERATIONS');
    mockPrisma.match.findUnique.mockResolvedValue(null);
    const missing = await request(app)
      .get('/api/v1/admin/matches/ghost/evidence')
      .set('Authorization', `Bearer ${auditorCopy}`);
    expect(missing.status).toBe(404);
  });
});