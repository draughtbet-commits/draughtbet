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
    jest.clearAllMocks();
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
});