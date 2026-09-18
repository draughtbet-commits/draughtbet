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
  KycAlreadyVerifiedError,
  KycInProgressError,
  KycRejectedError
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