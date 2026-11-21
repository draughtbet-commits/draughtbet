import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

const mockPrisma = {
  $transaction: jest.fn(async (cb) => cb(mockPrisma)),
  user: {
    findUnique: jest.fn(),
    update: jest.fn()
  },
  verificationCase: {
    create: jest.fn(),
    update: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn()
  },
  verificationCheck: {
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn()
  }
};

jest.unstable_mockModule('../../../utils/db.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

const {
  createKycProvider,
  SimulatedKycProvider,
  ManualReviewKycProvider,
  KycProviderError,
  isSimulatedKycAllowed
} = await import('../providerAdapter.js');

const {
  startVerification,
  approveVerificationCase,
  rejectVerificationCase,
  requestAdditionalKycInfo,
  VerificationSelfReviewError,
  VerificationAuthorizationError
} = await import('../service.js');

describe('KYC Self-Verification & Self-Approval Prevention', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...savedEnv };
    delete process.env.KYC_PROVIDER;
    delete process.env.ALLOW_SIMULATED_KYC;
    delete process.env.SIMULATION_ENABLED;

    mockPrisma.user.findUnique.mockResolvedValue({ id: 'player-1', kycStatus: 'NONE' });
    mockPrisma.user.update.mockImplementation(async ({ data }) => ({ id: 'player-1', ...data }));
    mockPrisma.verificationCase.findFirst.mockResolvedValue(null);
    mockPrisma.verificationCase.create.mockImplementation(async ({ data }) => ({
      id: 'case-1',
      ...data
    }));
    mockPrisma.verificationCheck.create.mockImplementation(async ({ data }) => ({
      id: 'check-1',
      ...data
    }));
    mockPrisma.verificationCase.update.mockImplementation(async ({ data }) => ({
      id: 'case-1',
      ...data
    }));
    mockPrisma.verificationCheck.update.mockImplementation(async ({ data }) => ({
      id: 'check-1',
      ...data
    }));
    mockPrisma.verificationCheck.updateMany.mockResolvedValue({ count: 1 });
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('forbids SimulatedKycProvider in production and defaults to ManualReviewKycProvider', () => {
    process.env.NODE_ENV = 'production';
    expect(isSimulatedKycAllowed()).toBe(false);
    expect(() => new SimulatedKycProvider()).toThrow(KycProviderError);
    expect(() => createKycProvider('simulated')).toThrow(KycProviderError);

    const defaultProvider = createKycProvider();
    expect(defaultProvider).toBeInstanceOf(ManualReviewKycProvider);
  });

  it('forbids SimulatedKycProvider in development unless explicitly opted in', () => {
    process.env.NODE_ENV = 'development';
    expect(isSimulatedKycAllowed()).toBe(false);
    expect(() => createKycProvider('simulated')).toThrow(KycProviderError);

    process.env.ALLOW_SIMULATED_KYC = 'true';
    expect(isSimulatedKycAllowed()).toBe(true);
    expect(createKycProvider('simulated')).toBeInstanceOf(SimulatedKycProvider);
  });

  it('queues default player KYC submissions into UNDER_REVIEW without verifying the user', async () => {
    process.env.NODE_ENV = 'production';
    const result = await startVerification('player-1', { type: 'ID_DOCUMENT' }, { dbp: mockPrisma });

    expect(result).toEqual({
      status: 'UNDER_REVIEW',
      caseId: 'case-1',
      checkId: 'check-1'
    });
    expect(mockPrisma.verificationCase.update).toHaveBeenCalledWith({
      where: { id: 'case-1' },
      data: { status: 'UNDER_REVIEW' }
    });
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'player-1' },
      data: { kycStatus: 'PENDING' }
    });
    // NEVER sets VERIFIED or ageVerified: true
    expect(mockPrisma.user.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kycStatus: 'VERIFIED' })
      })
    );
  });

  it('blocks even an injected simulated provider from auto-passing in production', async () => {
    process.env.NODE_ENV = 'production';
    const sneakySimulated = {
      start: async () => ({ providerReference: 'sim-bypass', provider: 'simulated' }),
      getResult: async () => ({ providerReference: 'sim-bypass', provider: 'simulated', status: 'PASSED' })
    };

    const result = await startVerification(
      'player-1',
      { type: 'ID_DOCUMENT' },
      { dbp: mockPrisma, provider: sneakySimulated }
    );
    expect(result.status).toBe('UNDER_REVIEW');
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'player-1' },
      data: { kycStatus: 'PENDING' }
    });
  });

  it('blocks administrators from self-approving, self-rejecting, or self-requesting info on their own KYC case', async () => {
    mockPrisma.verificationCase.findUnique.mockResolvedValue({
      id: 'case-self',
      userId: 'admin-self',
      status: 'UNDER_REVIEW',
      metadata: {}
    });

    await expect(
      approveVerificationCase('case-self', { adminId: 'admin-self', note: 'self', dbp: mockPrisma })
    ).rejects.toThrow(VerificationSelfReviewError);

    await expect(
      rejectVerificationCase('case-self', { adminId: 'admin-self', reason: 'self', dbp: mockPrisma })
    ).rejects.toThrow(VerificationSelfReviewError);

    await expect(
      requestAdditionalKycInfo('case-self', { adminId: 'admin-self', reason: 'self', dbp: mockPrisma })
    ).rejects.toThrow(VerificationSelfReviewError);

    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('requires an attributed adminId to approve or reject a reviewable case', async () => {
    mockPrisma.verificationCase.findUnique.mockResolvedValue({
      id: 'case-unattributed',
      userId: 'player-1',
      status: 'UNDER_REVIEW',
      metadata: {}
    });

    await expect(
      approveVerificationCase('case-unattributed', { adminId: null, dbp: mockPrisma })
    ).rejects.toThrow(VerificationAuthorizationError);

    await expect(
      rejectVerificationCase('case-unattributed', { adminId: null, dbp: mockPrisma })
    ).rejects.toThrow(VerificationAuthorizationError);
  });
});
