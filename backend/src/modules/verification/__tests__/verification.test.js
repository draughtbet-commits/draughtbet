import { jest } from '@jest/globals';

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    update: jest.fn()
  },
  verificationCase: {
    create: jest.fn(),
    update: jest.fn(),
    findFirst: jest.fn()
  },
  verificationCheck: {
    create: jest.fn(),
    update: jest.fn()
  }
};

jest.unstable_mockModule('../../../utils/db.js', () => ({
  default: mockPrisma
}));

jest.unstable_mockModule('../../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

const {
  startVerification,
  getKycStatus,
  listVerificationCases,
  approveVerificationCase,
  rejectVerificationCase,
  KycAlreadyVerifiedError,
  KycInProgressError,
  KycRejectedError,
  VerificationCaseNotFoundError,
  VerificationCaseNotReviewableError
} = await import('../service.js');

class FakePassProvider {
  constructor(result = 'PASSED') {
    this.result = result;
  }
  async start() {
    return { providerReference: 'fake-1', provider: 'simulated' };
  }
  async getResult() {
    return { providerReference: 'fake-1', status: this.result, checks: ['ID_DOCUMENT'] };
  }
}

describe('verification service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      kycStatus: 'NONE'
    });
    mockPrisma.user.update.mockImplementation(async ({ data }) => ({
      id: 'u1',
      ...data
    }));
    mockPrisma.verificationCase.findFirst.mockResolvedValue(null);
    mockPrisma.verificationCase.create.mockImplementation(async ({ data }) => ({
      id: 'case-1',
      ...data
    }));
    mockPrisma.verificationCheck.create.mockImplementation(async ({ data }) => ({
      id: 'check-1',
      ...data
    }));
  });

  it('verifies through a passing provider and projects kycStatus', async () => {
    const result = await startVerification('u1', {}, { provider: new FakePassProvider() });

    expect(result).toEqual({ status: 'VERIFIED', caseId: 'case-1', checkId: 'check-1' });
    expect(mockPrisma.verificationCase.update).toHaveBeenCalledWith({
      where: { id: 'case-1' },
      data: { status: 'VERIFIED' }
    });
    expect(mockPrisma.verificationCheck.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PASSED' })
      })
    );
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { kycStatus: 'VERIFIED', ageVerified: true }
    });
  });

  it('rejects and marks the case REJECTED when the provider fails', async () => {
    await expect(
      startVerification('u1', {}, { provider: new FakePassProvider('FAILED') })
    ).rejects.toThrow(KycRejectedError);

    expect(mockPrisma.verificationCase.update).toHaveBeenCalledWith({
      where: { id: 'case-1' },
      data: { status: 'REJECTED' }
    });
    expect(mockPrisma.verificationCheck.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED' })
      })
    );
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('refuses to re-verify an already verified user', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', kycStatus: 'VERIFIED' });
    await expect(
      startVerification('u1', {}, { provider: new FakePassProvider() })
    ).rejects.toThrow(KycAlreadyVerifiedError);
  });

  it('refuses to start while an earlier case is in-flight', async () => {
    mockPrisma.verificationCase.findFirst.mockResolvedValue({
      id: 'case-1',
      status: 'UNDER_REVIEW'
    });
    await expect(
      startVerification('u1', {}, { provider: new FakePassProvider() })
    ).rejects.toThrow(KycInProgressError);
  });

  it('returns the latest case in the status view', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      kycStatus: 'VERIFIED',
      verificationCases: [
        {
          id: 'case-1',
          status: 'VERIFIED',
          provider: 'simulated',
          createdAt: new Date(),
          updatedAt: new Date(),
          checks: [{ id: 'check-1', type: 'ID_DOCUMENT', status: 'PASSED', verifiedAt: new Date() }]
        }
      ]
    });
    const view = await getKycStatus('u1');
    expect(view.kycStatus).toBe('VERIFIED');
    expect(view.case.status).toBe('VERIFIED');
    expect(view.case.checks[0]).toMatchObject({ type: 'ID_DOCUMENT', status: 'PASSED' });
  });
});

describe('verification admin review', () => {
  const openCase = {
    id: 'case-admin',
    userId: 'u1',
    status: 'UNDER_REVIEW',
    metadata: { provider: 'simulated' }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction = jest.fn();
    mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
    mockPrisma.verificationCase.findUnique = jest.fn().mockResolvedValue(openCase);
    mockPrisma.verificationCase.findMany = jest.fn();
    mockPrisma.verificationCase.count = jest.fn();
    mockPrisma.verificationCase.update = jest.fn().mockImplementation(async ({ data }) => ({
      ...openCase,
      ...data
    }));
    mockPrisma.verificationCheck.updateMany = jest.fn().mockResolvedValue({ count: 1 });
    mockPrisma.user.update = jest.fn().mockImplementation(async ({ data }) => ({
      id: 'u1',
      ...data
    }));
  });

  it('lists cases newest-first with status filter and pagination', async () => {
    mockPrisma.verificationCase.findMany.mockResolvedValue([openCase]);
    mockPrisma.verificationCase.count.mockResolvedValue(25);

    const out = await listVerificationCases({ page: 2, limit: 20, status: 'UNDER_REVIEW', dbp: mockPrisma });

    expect(mockPrisma.verificationCase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'UNDER_REVIEW' }, skip: 20, take: 20 })
    );
    expect(out.totalPages).toBe(2);
  });

  it('approve passes open checks, marks the case verified and projects onto the user', async () => {
    const out = await approveVerificationCase('case-admin', { adminId: 'admin-1', note: 'docs ok', dbp: mockPrisma });

    expect(mockPrisma.verificationCheck.updateMany).toHaveBeenCalledWith({
      where: { caseId: 'case-admin', status: { in: ['PENDING', 'FAILED'] } },
      data: { status: 'PASSED', verifiedAt: expect.any(Date) }
    });
    expect(mockPrisma.verificationCase.update).toHaveBeenCalledWith({
      where: { id: 'case-admin' },
      data: expect.objectContaining({
        status: 'VERIFIED',
        metadata: expect.objectContaining({ reviewedBy: 'admin-1', note: 'docs ok' })
      })
    });
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { kycStatus: 'VERIFIED', ageVerified: true }
    });
    expect(out.replayed).toBe(false);
  });

  it('approve replays on an already-verified case without writes', async () => {
    mockPrisma.verificationCase.findUnique.mockResolvedValue({ ...openCase, status: 'VERIFIED' });

    const out = await approveVerificationCase('case-admin', { adminId: 'admin-1', dbp: mockPrisma });

    expect(out.replayed).toBe(true);
    expect(mockPrisma.verificationCheck.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('approve rejects a missing or non-reviewable case', async () => {
    mockPrisma.verificationCase.findUnique.mockResolvedValueOnce(null);
    await expect(
      approveVerificationCase('ghost', { dbp: mockPrisma })
    ).rejects.toThrow(VerificationCaseNotFoundError);

    mockPrisma.verificationCase.findUnique.mockResolvedValue({ ...openCase, status: 'PROCESSING' });
    await expect(
      approveVerificationCase('case-admin', { dbp: mockPrisma })
    ).rejects.toThrow(VerificationCaseNotReviewableError);
  });

  it('reject fails still-open checks and returns the user to PENDING', async () => {
    const out = await rejectVerificationCase('case-admin', { adminId: 'admin-1', reason: 'blurred doc', dbp: mockPrisma });

    expect(mockPrisma.verificationCheck.updateMany).toHaveBeenCalledWith({
      where: { caseId: 'case-admin', status: { in: ['PENDING'] } },
      data: { status: 'FAILED' }
    });
    expect(mockPrisma.verificationCase.update).toHaveBeenCalledWith({
      where: { id: 'case-admin' },
      data: expect.objectContaining({ status: 'REJECTED' })
    });
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { kycStatus: 'PENDING' }
    });
    expect(out.replayed).toBe(false);
  });

  it('reject refuses a verified case unless the override env is set', async () => {
    delete process.env.ADMIN_KYC_OVERRIDE_VERIFIED;
    mockPrisma.verificationCase.findUnique.mockResolvedValue({ ...openCase, status: 'VERIFIED' });

    await expect(
      rejectVerificationCase('case-admin', { adminId: 'admin-1', dbp: mockPrisma })
    ).rejects.toThrow('A verified case cannot be rejected');

    process.env.ADMIN_KYC_OVERRIDE_VERIFIED = 'true';
    const out = await rejectVerificationCase('case-admin', { adminId: 'admin-1', dbp: mockPrisma });
    expect(out.replayed).toBe(false);
    delete process.env.ADMIN_KYC_OVERRIDE_VERIFIED;
  });

  it('reject replays on an already-rejected case', async () => {
    mockPrisma.verificationCase.findUnique.mockResolvedValue({ ...openCase, status: 'REJECTED' });

    const out = await rejectVerificationCase('case-admin', { dbp: mockPrisma });

    expect(out.replayed).toBe(true);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });
});