import { jest } from '@jest/globals';

const mockPrisma = {
  user: { findUnique: jest.fn() },
  saferPlayProfile: { findUnique: jest.fn() },
  depositIntent: { aggregate: jest.fn() },
  platformSettings: { findUnique: jest.fn() }
};

jest.unstable_mockModule('../../../utils/db.js', () => ({
  default: mockPrisma
}));

jest.unstable_mockModule('../../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

jest.unstable_mockModule('../../saferPlay/service.js', () => ({
  enforceDepositLimit: jest.fn()
}));

const {
  EligibilityService,
  KycRequiredError,
  SelfExcludedError,
  TimeoutActiveError,
  StakeLimitExceededError,
  DepositLimitExceededError
} = await import('../service.js');

describe('EligibilityService', () => {
  let service;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new EligibilityService({ db: mockPrisma });
  });

  const baseUser = (overrides = {}) => ({
    id: 'user-1',
    countryCode: 'NG',
    kycStatus: 'VERIFIED',
    isBanned: false,
    eligibility: { id: 'elig-1', countryAllowed: true, ageVerified: true },
    saferPlayProfile: null,
    ...overrides
  });

  const profileWith = (overrides = {}) => ({
    stakeLimitMinorUnits: null,
    timeoutUntil: null,
    selfExcludedUntil: null,
    ...overrides
  });

  it('canWithdraw requires a verified KYC status', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser({ kycStatus: 'NONE' }));
    await expect(service.canWithdraw('user-1')).rejects.toThrow(KycRequiredError);
  });

  it('canWithdraw passes for a verified account', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser());
    await expect(service.canWithdraw('user-1')).resolves.toBeUndefined();
  });

  it('canDeposit passes without KYC (deposits are not KYC-gated)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser({ kycStatus: 'NONE' }));
    await expect(service.canDeposit('user-1', 5000n)).resolves.toBeUndefined();
  });

  it('canDeposit blocks a self-excluded player', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(
      baseUser({
        saferPlayProfile: profileWith({
          selfExcludedUntil: new Date(Date.now() + 86_400_000)
        })
      })
    );
    await expect(service.canDeposit('user-1', 5000n)).rejects.toThrow(SelfExcludedError);
  });

  it('canDeposit enforces the rolling deposit limit', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(baseUser());
    mockPrisma.saferPlayProfile.findUnique.mockResolvedValue(
      profileWith({ depositLimitMinorUnits: 10000n })
    );
    mockPrisma.platformSettings.findUnique.mockResolvedValue({ limitRaiseCoolingHours: 24 });
    mockPrisma.depositIntent.aggregate.mockResolvedValue({ _sum: { amountMinorUnits: 6000n } });
    const { enforceDepositLimit } = await import('../../saferPlay/service.js');

    enforceDepositLimit.mockRejectedValue(
      new DepositLimitExceededError('Deposit would exceed your daily limit')
    );
    await expect(service.canDeposit('user-1', 5000n)).rejects.toThrow(DepositLimitExceededError);
  });

  it('canJoinMatch blocks a player on timeout', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(
      baseUser({
        saferPlayProfile: profileWith({
          timeoutUntil: new Date(Date.now() + 60 * 60 * 1000)
        })
      })
    );
    await expect(
      service.canJoinMatch('user-1', { stakeMinorUnits: 5000n })
    ).rejects.toThrow(TimeoutActiveError);
  });

  it('canJoinMatch blocks a stake above the player stake limit', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(
      baseUser({
        saferPlayProfile: profileWith({ stakeLimitMinorUnits: 1000n })
      })
    );
    await expect(
      service.canJoinMatch('user-1', { stakeMinorUnits: 5000n })
    ).rejects.toThrow(StakeLimitExceededError);
  });

  it('canStake runs the same gate against a transaction client', async () => {
    const tx = { user: { findUnique: jest.fn().mockResolvedValue(baseUser()) } };
    await expect(service.canStake(tx, 'user-1', 5000n, { requireKyc: true })).resolves.toBeUndefined();
  });

  it('canStake with requireKyc rejects an unverified player', async () => {
    const tx = {
      user: {
        findUnique: jest.fn().mockResolvedValue(baseUser({ kycStatus: 'NONE' }))
      }
    };
    await expect(service.canStake(tx, 'user-1', 5000n, { requireKyc: true })).rejects.toThrow(KycRequiredError);
  });

  it('maps eligibility errors to HTTP status codes', () => {
    expect(EligibilityService.statusCode(new SelfExcludedError())).toBe(403);
    expect(EligibilityService.statusCode(new TimeoutActiveError())).toBe(403);
    expect(EligibilityService.statusCode(new StakeLimitExceededError())).toBe(422);
    expect(EligibilityService.statusCode(new Error('boom'))).toBe(500);
  });

  describe('explain (contract §4 /me/eligibility)', () => {
    it('explains a passing WITHDRAW gate with its witnessed requirements', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(baseUser());
      const report = await service.explain('user-1', { action: 'WITHDRAW' });
      expect(report).toEqual({
        allowed: true,
        requirements: [
          'eligibility:on_file',
          'country:allowed',
          'age:verified',
          'account:active',
          'safer_play:ok',
          'kyc:verified'
        ]
      });
    });

    it('reports a KYC failure as not-allowed (never throws)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(baseUser({ kycStatus: 'NONE' }));
      const report = await service.explain('user-1', { action: 'WITHDRAW' });
      expect(report).toMatchObject({ allowed: false, status: 403 });
      expect(report.error.code).toBe('KycRequiredError');
    });

    it('does not KYC-gate a DEPOSIT', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(baseUser({ kycStatus: 'NONE' }));
      mockPrisma.saferPlayProfile.findUnique.mockResolvedValue(profileWith());
      const { enforceDepositLimit } = await import('../../saferPlay/service.js');
      enforceDepositLimit.mockResolvedValue(undefined);
      const report = await service.explain('user-1', { action: 'DEPOSIT', amountMinorUnits: '5000' });
      expect(report).toMatchObject({ allowed: true });
      expect(report.requirements).not.toContain('kyc:verified');
    });

    it('reports an active PLAY timeout', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(
        baseUser({
          kycStatus: 'NONE',
          saferPlayProfile: profileWith({ timeoutUntil: new Date(Date.now() + 60 * 60 * 1000) })
        })
      );
      const report = await service.explain('user-1', { action: 'PLAY', amountMinorUnits: '5000' });
      expect(report).toMatchObject({ allowed: false, status: 403 });
      expect(report.error.code).toBe('TimeoutActiveError');
    });

    it('reports a stake above the player stake limit', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(
        baseUser({ saferPlayProfile: profileWith({ stakeLimitMinorUnits: 1000n }) })
      );
      const report = await service.explain('user-1', { action: 'PLAY', amountMinorUnits: '5000' });
      expect(report).toMatchObject({ allowed: false, status: 422 });
      expect(report.error.code).toBe('StakeLimitExceededError');
    });

    it('passes PLAY at or under the stake limit', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(
        baseUser({ kycStatus: 'NONE', saferPlayProfile: profileWith({ stakeLimitMinorUnits: null }) })
      );
      const report = await service.explain('user-1', { action: 'JOIN', amountMinorUnits: '5000' });
      expect(report).toMatchObject({ allowed: true });
    });

    it('surfaces the deposit-limit prohibition for a DEPOSIT', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(baseUser({ kycStatus: 'NONE' }));
      const { enforceDepositLimit } = await import('../../saferPlay/service.js');
      enforceDepositLimit.mockRejectedValue(
        new DepositLimitExceededError('Deposit would exceed your daily limit')
      );
      const report = await service.explain('user-1', { action: 'DEPOSIT', amountMinorUnits: '5000' });
      expect(report).toMatchObject({ allowed: false, status: 422 });
      expect(report.error.code).toBe('DepositLimitExceededError');
    });

    it('reports a self-exclusion for any money action', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(
        baseUser({ saferPlayProfile: profileWith({ selfExcludedUntil: new Date(Date.now() + 86_400_000) }) })
      );
      const report = await service.explain('user-1', { action: 'DEPOSIT' });
      expect(report).toMatchObject({ allowed: false, status: 403 });
      expect(report.error.code).toBe('SelfExcludedError');
    });

    it('reports when the account eligibility is not on file', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(baseUser({ eligibility: null }));
      const report = await service.explain('user-1', { action: 'WITHDRAW' });
      expect(report).toMatchObject({ allowed: false, status: 403 });
      expect(report.error.code).toBe('EligibilityRequiredError');
    });

    it('rejects an unknown action', async () => {
      const report = await service.explain('user-1', { action: 'POKER' });
      expect(report).toMatchObject({ allowed: false, status: 400 });
      expect(report.error.code).toBe('INVALID_ACTION');
    });
  });
});