import { jest } from '@jest/globals';

const mockPrisma = {
  user: {
    findUnique: jest.fn()
  },
  platformSettings: {
    findUniqueOrThrow: jest.fn()
  }
};

jest.unstable_mockModule('../../utils/db.js', () => ({
  default: mockPrisma
}));

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
};

jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: mockLogger
}));

describe('tierEnforcement', () => {
  let tierEnforcement;

  beforeAll(async () => {
    tierEnforcement = await import('../tierEnforcement.js');
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const runMiddleware = async (req, isCallout = false) => {
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    const next = jest.fn();
    const middleware = tierEnforcement.requireValidStake(isCallout);
    await middleware(req, res, next);
    return { res, next };
  };

  it('should reject missing stakeMinorUnits', async () => {
    const req = { user: { userId: '1' }, body: {} };
    const { res } = await runMiddleware(req);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('should validate an exact preset for AMATEUR tier (matchmaking)', async () => {
    // 50,000 is a valid amateur preset
    const req = { user: { userId: '1' }, body: { stakeMinorUnits: '50000' } };
    mockPrisma.user.findUnique.mockResolvedValue({ tier: 'AMATEUR' });
    mockPrisma.platformSettings.findUniqueOrThrow.mockResolvedValue({
      amateurStakeMinP: 50000n,
      amateurStakeMaxP: 1500000n
    });

    const { next } = await runMiddleware(req, false);
    expect(next).toHaveBeenCalled();
    expect(req.user.tier).toBe('AMATEUR');
  });

  it('should reject an arbitrary valid amount that is not a preset for AMATEUR tier (matchmaking)', async () => {
    // 50001 is within bounds but not a preset
    const req = { user: { userId: '1' }, body: { stakeMinorUnits: '50001' } };
    mockPrisma.user.findUnique.mockResolvedValue({ tier: 'AMATEUR' });
    mockPrisma.platformSettings.findUniqueOrThrow.mockResolvedValue({
      amateurStakeMinP: 50000n,
      amateurStakeMaxP: 1500000n
    });

    const { res } = await runMiddleware(req, false);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('Must be one of') })
    );
  });

  it('should accept a free-form callout stake within callout ceiling bounds', async () => {
    // Callouts don't require presets, just boundary checks.
    // 14M is well above amateurStakeMaxP, but within callout max.
    // Wait, amateur has 0 callout max in the spec! Let's test PRO.
    const req = { user: { userId: '1' }, body: { stakeMinorUnits: '25000000' } };
    mockPrisma.user.findUnique.mockResolvedValue({ tier: 'PRO' });
    mockPrisma.platformSettings.findUniqueOrThrow.mockResolvedValue({
      proStakeMinP: 3000000n,
      proCalloutMaxP: 30000000n
    });

    const { next } = await runMiddleware(req, true);
    expect(next).toHaveBeenCalled();
  });

  it('should reject callouts for tiers with 0 callout max', async () => {
    const req = { user: { userId: '1' }, body: { stakeMinorUnits: '50000' } };
    mockPrisma.user.findUnique.mockResolvedValue({ tier: 'AMATEUR' });
    mockPrisma.platformSettings.findUniqueOrThrow.mockResolvedValue({
      amateurStakeMinP: 50000n,
      amateurCalloutMaxP: 0n // Not eligible
    });

    const { res } = await runMiddleware(req, true);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('not eligible for call-outs') })
    );
  });
});
