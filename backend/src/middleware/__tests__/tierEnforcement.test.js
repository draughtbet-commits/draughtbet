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

  it('should accept an arbitrary in-range amount for AMATEUR tier (matchmaking)', async () => {
    // Stakes are a range now, not presets: any value between min and max is valid.
    const req = { user: { userId: '1' }, body: { stakeMinorUnits: '123456' } };
    mockPrisma.user.findUnique.mockResolvedValue({ tier: 'AMATEUR' });
    mockPrisma.platformSettings.findUniqueOrThrow.mockResolvedValue({
      amateurStakeMinP: 50000n,
      amateurStakeMaxP: 5000000n
    });

    const { next } = await runMiddleware(req, false);
    expect(next).toHaveBeenCalled();
    expect(req.user.tier).toBe('AMATEUR');
  });

  it('should reject a matchmaking stake below the tier minimum', async () => {
    const req = { user: { userId: '1' }, body: { stakeMinorUnits: '49999' } };
    mockPrisma.user.findUnique.mockResolvedValue({ tier: 'AMATEUR' });
    mockPrisma.platformSettings.findUniqueOrThrow.mockResolvedValue({
      amateurStakeMinP: 50000n,
      amateurStakeMaxP: 5000000n
    });

    const { res } = await runMiddleware(req, false);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('between') })
    );
  });

  it('should reject a matchmaking stake above the tier maximum', async () => {
    const req = { user: { userId: '1' }, body: { stakeMinorUnits: '5000001' } };
    mockPrisma.user.findUnique.mockResolvedValue({ tier: 'AMATEUR' });
    mockPrisma.platformSettings.findUniqueOrThrow.mockResolvedValue({
      amateurStakeMinP: 50000n,
      amateurStakeMaxP: 5000000n
    });

    const { res } = await runMiddleware(req, false);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('should accept a callout stake within the callout ceiling bounds', async () => {
    const req = { user: { userId: '1' }, body: { stakeMinorUnits: '25000000' } };
    mockPrisma.user.findUnique.mockResolvedValue({ tier: 'PRO' });
    mockPrisma.platformSettings.findUniqueOrThrow.mockResolvedValue({
      proStakeMinP: 50000n,
      proCalloutMaxP: 30000000n
    });

    const { next } = await runMiddleware(req, true);
    expect(next).toHaveBeenCalled();
  });

  it('should reject a callout stake above the callout ceiling', async () => {
    const req = { user: { userId: '1' }, body: { stakeMinorUnits: '30000001' } };
    mockPrisma.user.findUnique.mockResolvedValue({ tier: 'PRO' });
    mockPrisma.platformSettings.findUniqueOrThrow.mockResolvedValue({
      proStakeMinP: 50000n,
      proCalloutMaxP: 30000000n
    });

    const { res } = await runMiddleware(req, true);
    expect(res.status).toHaveBeenCalledWith(400);
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
