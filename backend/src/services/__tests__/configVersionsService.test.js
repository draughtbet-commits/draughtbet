import { jest } from '@jest/globals';

const mockPrisma = {
  $transaction: jest.fn(),
  rulesetVersion: { count: jest.fn(), create: jest.fn() },
  platformConfigVersion: {
    count: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    create: jest.fn()
  },
  platformSettings: { findUnique: jest.fn(), update: jest.fn() }
};

jest.unstable_mockModule('../../utils/db.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

const { ensureActiveConfigVersions, updatePlatformConfig, settingsPayload } =
  await import('../configVersionsService.js');

const SETTINGS = {
  id: 'singleton',
  commissionPercent: 10,
  limitRaiseCoolingHours: 24,
  timeControlSeconds: 60,
  amateurStakeMinP: BigInt(50000),
  amateurStakeMaxP: BigInt(1500000),
  masterStakeMinP: BigInt(1000000),
  masterStakeMaxP: BigInt(3000000),
  proStakeMinP: BigInt(3000000),
  proStakeMaxP: BigInt(6000000),
  amateurCalloutMaxP: BigInt(0),
  masterCalloutMaxP: BigInt(15000000),
  proCalloutMaxP: BigInt(30000000)
};

describe('configVersionsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
    mockPrisma.platformSettings.findUnique.mockResolvedValue(SETTINGS);
  });

  it('seeds the active ruleset and config version once on a fresh DB', async () => {
    mockPrisma.rulesetVersion.count.mockResolvedValue(0);
    mockPrisma.platformConfigVersion.count.mockResolvedValue(0);

    const result = await ensureActiveConfigVersions();

    expect(result).toEqual({ rulesetSeed: true, configSeed: true });
    expect(mockPrisma.rulesetVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ id: 'draughts-x1-w', active: true }) })
    );
    expect(mockPrisma.platformConfigVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          version: 'v1',
          values: expect.objectContaining({ amateurStakeMinP: '50000', commissionPercent: 10 })
        })
      })
    );
  });

  it('is a no-op when an active ruleset + config already exist', async () => {
    mockPrisma.rulesetVersion.count.mockResolvedValue(1);
    mockPrisma.platformConfigVersion.count.mockResolvedValue(1);

    const result = await ensureActiveConfigVersions();

    expect(result).toEqual({ rulesetSeed: false, configSeed: false });
    expect(mockPrisma.rulesetVersion.create).not.toHaveBeenCalled();
    expect(mockPrisma.platformConfigVersion.create).not.toHaveBeenCalled();
  });

  it('updates the singleton, closes the active version and appends a new snapshot', async () => {
    mockPrisma.platformConfigVersion.findFirst.mockResolvedValue({ id: 'cfg-1', activeTo: null });
    mockPrisma.platformConfigVersion.count.mockResolvedValue(1);
    mockPrisma.platformSettings.update.mockImplementation(async ({ data }) => ({ ...SETTINGS, ...data }));

    const updated = await updatePlatformConfig({
      userId: 'admin-1',
      updates: { commissionPercent: 15, proStakeMinP: '4000000' }
    });

    expect(mockPrisma.platformSettings.update).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      data: { commissionPercent: 15, proStakeMinP: BigInt(4000000) }
    });
    expect(mockPrisma.platformConfigVersion.update).toHaveBeenCalledWith({
      where: { id: 'cfg-1' },
      data: { activeTo: expect.any(Date) }
    });
    const appended = mockPrisma.platformConfigVersion.create.mock.calls[0][0].data;
    expect(appended.version).toBe('v2');
    expect(appended.createdByUserId).toBe('admin-1');
    expect(appended.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(appended.values).toMatchObject({ commissionPercent: 15, proStakeMinP: '4000000' });
    expect(updated.proStakeMinP).toBe(BigInt(4000000));
  });

  it('rejects an update with no supported settings', async () => {
    await expect(updatePlatformConfig({ userId: 'admin-1', updates: { nope: 1 } })).rejects.toThrow(
      'No supported settings supplied'
    );
    expect(mockPrisma.platformSettings.update).not.toHaveBeenCalled();
  });

  it('serializes settings to JSON-safe payload (BigInt money as decimal strings)', () => {
    expect(settingsPayload(SETTINGS)).toMatchObject({ commissionPercent: 10, amateurStakeMinP: '50000' });
  });
});