import { jest } from '@jest/globals';
import { DepositLimitExceededError } from '../../../services/eligibilityService.js';

const mockPrisma = {
  platformSettings: { findUnique: jest.fn() },
  saferPlayProfile: {
    findUnique: jest.fn(),
    upsert: jest.fn()
  },
  saferPlayEvent: { create: jest.fn() },
  depositIntent: { aggregate: jest.fn() }
};

jest.unstable_mockModule('../../../utils/db.js', () => ({
  default: mockPrisma
}));

jest.unstable_mockModule('../../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

jest.unstable_mockModule('../../../modules/wallet/service.js', () => ({
  parseMinorUnits: (raw) => {
    const str = typeof raw === 'number' || typeof raw === 'bigint' ? String(raw) : raw;
    if (typeof str !== 'string' || !/^\d+$/.test(str.trim())) return null;
    return BigInt(str.trim());
  }
}));

const service = await import('../service.js');

describe('saferPlay service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.platformSettings.findUnique.mockResolvedValue({
      limitRaiseCoolingHours: 24
    });
  });

  it('applies a first-time deposit limit immediately (SET)', async () => {
    mockPrisma.saferPlayProfile.findUnique.mockResolvedValue(null);
    mockPrisma.saferPlayProfile.upsert.mockImplementation(async ({ create, update }) => ({
      id: 'p1',
      userId: 'u1',
      ...(create ?? update)
    }));

    const profile = await service.setDepositLimit('u1', '10000');

    expect(mockPrisma.saferPlayProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'u1' },
        create: expect.objectContaining({ depositLimitMinorUnits: 10000n })
      })
    );
    expect(profile.effectiveDepositLimitMinorUnits).toBe('10000');
    expect(mockPrisma.saferPlayEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'u1',
          action: 'SET',
          field: 'depositLimitMinorUnits',
          newValue: '10000'
        })
      })
    );
  });

  it('stages a RAISE pending the cooling window without changing the effective limit', async () => {
    mockPrisma.saferPlayProfile.findUnique.mockResolvedValue({
      id: 'p1',
      userId: 'u1',
      depositLimitMinorUnits: 10000n,
      pendingDepositLimitMinorUnits: null,
      pendingDepositLimitRaisedAt: null,
      stakeLimitMinorUnits: null,
      pendingStakeLimitMinorUnits: null,
      pendingStakeLimitRaisedAt: null,
      timeoutUntil: null,
      selfExcludedUntil: null
    });
    mockPrisma.saferPlayProfile.upsert.mockImplementation(async ({ update }) => ({
      id: 'p1',
      userId: 'u1',
      depositLimitMinorUnits: 10000n,
      stakeLimitMinorUnits: null,
      timeoutUntil: null,
      selfExcludedUntil: null,
      ...update,
      pendingStakeLimitMinorUnits: null,
      pendingStakeLimitRaisedAt: null
    }));

    const now = new Date('2026-01-01T12:00:00Z');
    const profile = await service.setDepositLimit('u1', '50000', { now });

    expect(profile.effectiveDepositLimitMinorUnits).toBe('10000');
    expect(profile.pendingDepositLimitMinorUnits).toBe('50000');
    expect(profile.pendingDepositLimitRaisedAt).toBeDefined();
    expect(mockPrisma.saferPlayEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          field: 'pendingDepositLimitMinorUnits',
          newValue: '50000'
        })
      })
    );
  });

  it('lowers a deposit limit immediately and clears any pending raise', async () => {
    mockPrisma.saferPlayProfile.findUnique.mockResolvedValue({
      id: 'p1',
      userId: 'u1',
      depositLimitMinorUnits: 10000n,
      pendingDepositLimitMinorUnits: 50000n,
      pendingDepositLimitRaisedAt: new Date(),
      stakeLimitMinorUnits: null,
      pendingStakeLimitMinorUnits: null,
      pendingStakeLimitRaisedAt: null,
      timeoutUntil: null,
      selfExcludedUntil: null
    });
    mockPrisma.saferPlayProfile.upsert.mockImplementation(async ({ update }) => ({
      id: 'p1',
      userId: 'u1',
      ...(update ?? {}),
      stakeLimitMinorUnits: null,
      pendingStakeLimitMinorUnits: null,
      pendingStakeLimitRaisedAt: null,
      timeoutUntil: null,
      selfExcludedUntil: null
    }));

    const now = new Date('2026-01-01T12:00:00Z');
    const profile = await service.setDepositLimit('u1', '5000', { now });

    expect(profile.effectiveDepositLimitMinorUnits).toBe('5000');
    expect(profile.pendingDepositLimitMinorUnits).toBeNull();
  });

  it('only ever extends a timeout', async () => {
    mockPrisma.saferPlayProfile.findUnique.mockResolvedValue({
      id: 'p1',
      userId: 'u1',
      timeoutUntil: new Date('2026-01-02T00:00:00Z'),
      selfExcludedUntil: null
    });

    const now = new Date('2026-01-01T12:00:00Z');
    await expect(
      service.startTimeout('u1', 60, { now }) // ends 13:00, earlier than 00:00 tomorrow
    ).rejects.toThrow(service.TimeoutShrinkError);

    mockPrisma.saferPlayProfile.upsert.mockImplementation(async ({ data }) => ({
      id: 'p1',
      userId: 'u1',
      ...data,
      selfExcludedUntil: null
    }));
    const extended = await service.startTimeout('u1', 72 * 60, { now });
    expect(extended.timeoutUntil).toBeDefined();
  });

  it('only ever extends a self-exclusion', async () => {
    mockPrisma.saferPlayProfile.findUnique.mockResolvedValue({
      id: 'p1',
      userId: 'u1',
      timeoutUntil: null,
      selfExcludedUntil: new Date('2026-08-01T00:00:00Z')
    });

    const now = new Date('2026-01-01T12:00:00Z');
    await expect(
      service.extendSelfExclusion('u1', '7d', { now })
    ).rejects.toThrow(service.SelfExclusionShrinkError);
  });

  it('enforces the rolling 24h deposit limit', async () => {
    mockPrisma.saferPlayProfile.findUnique.mockResolvedValue({
      id: 'p1',
      userId: 'u1',
      depositLimitMinorUnits: 20000n,
      pendingDepositLimitMinorUnits: null,
      pendingDepositLimitRaisedAt: null,
      stakeLimitMinorUnits: null,
      pendingStakeLimitMinorUnits: null,
      pendingStakeLimitRaisedAt: null,
      timeoutUntil: null,
      selfExcludedUntil: null
    });
    mockPrisma.depositIntent.aggregate.mockResolvedValue({
      _sum: { amountMinorUnits: 6000n }
    });
    const now = new Date('2026-01-01T12:00:00Z');

    await expect(
      service.enforceDepositLimit(mockPrisma, 'u1', 5000n, { now })
    ).resolves.toBeUndefined();
    expect(mockPrisma.depositIntent.aggregate).toHaveBeenCalledWith({
      where: {
        userId: 'u1',
        status: 'COMPLETED',
        createdAt: { gte: new Date('2025-12-31T12:00:00Z') }
      },
      _sum: { amountMinorUnits: true }
    });

    mockPrisma.depositIntent.aggregate.mockResolvedValue({
      _sum: { amountMinorUnits: 15001n }
    });
    await expect(
      service.enforceDepositLimit(mockPrisma, 'u1', 5000n, { now })
    ).rejects.toThrow(DepositLimitExceededError);
  });

  it('does not enforce a deposit limit when none is set', async () => {
    mockPrisma.saferPlayProfile.findUnique.mockResolvedValue(null);
    await expect(
      service.enforceDepositLimit(mockPrisma, 'u1', 50000000n)
    ).resolves.toBeUndefined();
    expect(mockPrisma.depositIntent.aggregate).not.toHaveBeenCalled();
  });
});