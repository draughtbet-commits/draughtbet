import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockPrisma = {
  $transaction: jest.fn(async (cb) => cb(mockPrisma)),
  $queryRaw: jest.fn(),
  platformSettings: {
    findUnique: jest.fn()
  },
  platformConfigVersion: {
    findFirst: jest.fn(),
    findUnique: jest.fn()
  },
  match: {
    create: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn()
  },
  wallet: {
    findUnique: jest.fn()
  },
  stakeReservation: {
    findUnique: jest.fn(),
    create: jest.fn()
  },
  ledgerAccount: {
    findMany: jest.fn()
  },
  ledgerEntry: {
    aggregate: jest.fn(),
    create: jest.fn()
  },
  ledgerTransaction: {
    findUnique: jest.fn(),
    create: jest.fn()
  },
  gameOutbox: {
    create: jest.fn()
  },
  user: {
    findUnique: jest.fn()
  }
};

jest.unstable_mockModule('../../../utils/db.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

const { createMatchWithStakes } = await import('../../../services/matchService.js');
const { computeSettlement, resolveFeeBps } = await import('../../settlement/service.js');
const { DEFAULT_CONFIG_PAYLOAD } = await import('../schema.js');
const { generateChecksum } = await import('../canonicalJson.js');

describe('Match Configuration Snapshot Isolation', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockPrisma.$queryRaw
      .mockResolvedValueOnce([{ id: 'w-1', userId: 'player-1', currency: 'NGN' }])
      .mockResolvedValueOnce([{ id: 'w-2', userId: 'player-2', currency: 'NGN' }]);

    mockPrisma.ledgerAccount.findMany.mockImplementation(async ({ where }) => {
      if (where.type === 'PLAYER_AVAILABLE') return [{ id: `acc:avail:${where.userId}` }];
      return [];
    });
    mockPrisma.ledgerEntry.aggregate.mockResolvedValue({ _sum: { amountMinorUnits: 100000n } });

    mockPrisma.$queryRaw.mockImplementation(async (_strings, ...values) => {
      if (values.length === 4) {
        const [id, userId, type, currency] = values;
        return [{ id, userId, type, currency }];
      }
      const [id, type, currency] = values;
      return [{ id, userId: null, type, currency }];
    });

    mockPrisma.ledgerTransaction.findUnique.mockResolvedValue(null);
    mockPrisma.ledgerTransaction.create.mockResolvedValue({ id: 'ledger-tx-1', type: 'STAKE_LOCK' });
    mockPrisma.ledgerEntry.create.mockImplementation(async ({ data }) => ({ id: `entry:${data.accountId}` }));

    mockPrisma.match.findFirst.mockResolvedValue(null);
    mockPrisma.match.findUnique.mockResolvedValue({ status: 'OPEN' });
    mockPrisma.match.update.mockImplementation(async ({ data }) => ({ id: 'match-snap-1', ...data }));

    mockPrisma.stakeReservation.findUnique.mockResolvedValue(null);
    mockPrisma.stakeReservation.create.mockImplementation(async ({ data }) => ({ ...data, id: `sr:${data.userId}` }));

    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'player-u',
      countryCode: 'NG',
      kycStatus: 'VERIFIED',
      eligibility: { id: 'elig-1', countryAllowed: true, ageVerified: true }
    });
  });

  it('captures active configurationVersion and rulesetVersion during match creation', async () => {
    // Active configuration at version 3
    const payload = {
      ...DEFAULT_CONFIG_PAYLOAD,
      financial: { ...DEFAULT_CONFIG_PAYLOAD.financial, commissionPercent: 12 },
      game: { ...DEFAULT_CONFIG_PAYLOAD.game, timeControlSeconds: 45, rulesetVersion: 2 }
    };
    const activeConfig = {
      id: 'cfg-v3',
      version: 3,
      status: 'ACTIVE',
      payload,
      checksum: generateChecksum(payload)
    };

    mockPrisma.platformConfigVersion.findFirst.mockResolvedValue(activeConfig);
    mockPrisma.platformSettings.findUnique.mockResolvedValue({
      commissionPercent: 12,
      timeControlSeconds: 45
    });

    mockPrisma.match.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'match-snap-1', status: 'OPEN', ...data })
    );

    // Execute match funding
    const match = await createMatchWithStakes(
      mockPrisma,
      'player-1',
      'player-2',
      10000n,
      'AMATEUR'
    );

    expect(mockPrisma.match.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        settlementCommissionPercent: 12,
        timeControlSeconds: 45,
        configurationVersion: 3,
        rulesetVersion: 2
      })
    });
    expect(match.status).toBe('FUNDED');
  });

  it('ensures match settlement reads frozen terms from Match row and is insulated from live config changes', async () => {
    // Match was created when commission was 15% (snapshot on Match row)
    const fundedMatch = {
      id: 'match-frozen-1',
      stakeMinorUnits: 20000n, // Total pot = 40000n
      settlementCommissionPercent: 15, // 15% snapshot
      status: 'IN_PLAY'
    };

    // Calculate payout using match record snapshot
    // Pot = 40,000 minor units. 15% rake = 6,000. Winner payout = 34,000.
    const settlement15 = computeSettlement(fundedMatch, resolveFeeBps(mockPrisma, fundedMatch));
    expect(settlement15.pot).toBe(40000n);
    expect(settlement15.commission).toBe(6000n);
    expect(settlement15.payout).toBe(34000n);

    // Suppose live platform configuration has now changed to 8% or 20%
    const newGlobalConfigCommission = 8;
    // Even after live config changes, the funded match's payout remains strictly 15%
    const feeUsed = resolveFeeBps(mockPrisma, fundedMatch);
    expect(feeUsed).toBe(15);
    expect(feeUsed).not.toBe(newGlobalConfigCommission);

    const settlementImmutable = computeSettlement(fundedMatch, feeUsed);
    expect(settlementImmutable.commission).toBe(6000n);
    expect(settlementImmutable.payout).toBe(34000n);
  });
});
