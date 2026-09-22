import { jest } from '@jest/globals';

process.env.DATABASE_URL = '';
process.env.REDIS_URL = '';
process.env.NODE_ENV = 'test';
process.env.ADMIN_CORS_ORIGIN = 'http://localhost';

const mockPrisma = {
  user: {
    findUnique: jest.fn()
  },
  match: {
    findFirst: jest.fn()
  },
  platformSettings: {
    findUniqueOrThrow: jest.fn()
  }
};
jest.unstable_mockModule('../../../utils/db.js', () => ({
  default: mockPrisma
}));

jest.unstable_mockModule('../../../middleware/auth.js', () => ({
  requireAuth: (req, res, next) => {
    req.user = { id: 'user-1', email: 'user@test.com', tier: 'AMATEUR', isBanned: false };
    next();
  }
}));

const mockRedis = {
  zadd: jest.fn(),
  zrem: jest.fn(),
  defineCommand: jest.fn()
};
jest.unstable_mockModule('../../../utils/redis.js', () => ({
  default: mockRedis,
  isRedisReady: jest.fn().mockReturnValue(true)
}));

const logger = (await import('../../../utils/logger.js')).default;
jest.spyOn(logger, 'info').mockImplementation(() => {});
jest.spyOn(logger, 'warn').mockImplementation(() => {});
jest.spyOn(logger, 'error').mockImplementation(() => {});

const { default: app } = await import('../../../app.js');
const { default: request } = await import('supertest');

describe('Matchmaking smoke', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      tier: 'AMATEUR',
      countryCode: 'NG',
      kycStatus: 'VERIFIED',
      eligibility: { id: 'elig-1', countryAllowed: true, ageVerified: true }
    });
    mockPrisma.platformSettings.findUniqueOrThrow.mockResolvedValue({
      amateurStakeMinP: 50000n,
      amateurStakeMaxP: 1500000n,
      masterStakeMinP: 1000000n,
      masterStakeMaxP: 3000000n,
      proStakeMinP: 3000000n,
      proStakeMaxP: 6000000n
    });
    mockPrisma.match.findFirst.mockResolvedValue(null);
  });

  it('joins the queue bucketed by tier and exact stake preset', async () => {
    mockRedis.zadd.mockResolvedValue(1);
    const res = await request(app).post('/api/v1/matchmaking/join').send({ stakeMinorUnits: 50000 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'queued', queueKey: 'queue:AMATEUR:50000' });
    expect(mockRedis.zadd).toHaveBeenCalledWith('queue:AMATEUR:50000', expect.any(Number), 'user-1');
  });

  it('blocks a player who already holds an ACTIVE match from the queue', async () => {
    mockPrisma.match.findFirst.mockResolvedValue({ id: 'other-game' });
    const res = await request(app).post('/api/v1/matchmaking/join').send({ stakeMinorUnits: 50000 });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'You are already in an active match' });
    expect(mockRedis.zadd).not.toHaveBeenCalled();
  });

  it('allows queue join without KYC verification (KYC gates money-out only)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      tier: 'AMATEUR',
      countryCode: 'NG',
      kycStatus: 'NONE',
      isBanned: false,
      eligibility: { id: 'elig-1', countryAllowed: true, ageVerified: true }
    });
    const res = await request(app).post('/api/v1/matchmaking/join').send({ stakeMinorUnits: 50000 });
    expect(res.status).toBe(200);
    expect(mockRedis.zadd).toHaveBeenCalled();
  });

  it('blocks queue join while a break (timeout) is active, server-side across devices', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      tier: 'AMATEUR',
      countryCode: 'NG',
      kycStatus: 'VERIFIED',
      isBanned: false,
      eligibility: { id: 'elig-1', countryAllowed: true, ageVerified: true },
      saferPlayProfile: {
        stakeLimitMinorUnits: null,
        timeoutUntil: new Date(Date.now() + 60 * 60 * 1000),
        selfExcludedUntil: null
      }
    });
    const res = await request(app).post('/api/v1/matchmaking/join').send({ stakeMinorUnits: 50000 });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('break is active');
    expect(mockRedis.zadd).not.toHaveBeenCalled();
  });

  it('blocks queue join for a self-excluded player', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      tier: 'AMATEUR',
      countryCode: 'NG',
      kycStatus: 'VERIFIED',
      isBanned: false,
      eligibility: { id: 'elig-1', countryAllowed: true, ageVerified: true },
      saferPlayProfile: {
        stakeLimitMinorUnits: null,
        timeoutUntil: null,
        selfExcludedUntil: new Date(Date.now() + 7 * 86_400_000)
      }
    });
    const res = await request(app).post('/api/v1/matchmaking/join').send({ stakeMinorUnits: 50000 });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Self-exclusion');
    expect(mockRedis.zadd).not.toHaveBeenCalled();
  });

  it('requires stakeMinorUnits to leave the queue', async () => {
    const res = await request(app).post('/api/v1/matchmaking/leave').send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'stakeMinorUnits is required' });
  });

  it('leaves the queue', async () => {
    mockRedis.zrem.mockResolvedValue(1);
    const res = await request(app).post('/api/v1/matchmaking/leave').send({ stakeMinorUnits: 50000 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'dequeued' });
    expect(mockRedis.zrem).toHaveBeenCalledWith('queue:AMATEUR:50000', 'user-1');
  });
});