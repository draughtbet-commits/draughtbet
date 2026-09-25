import { jest } from '@jest/globals';

process.env.DATABASE_URL = '';
process.env.REDIS_URL = '';
process.env.NODE_ENV = 'test';
process.env.ADMIN_CORS_ORIGIN = 'http://localhost';

const mockPrisma = {
  user: {
    findMany: jest.fn(),
    findFirst: jest.fn()
  }
};
jest.unstable_mockModule('../../../utils/db.js', () => ({
  default: mockPrisma
}));

// Mirrors the real guard: an authenticated request carries a Bearer token.
jest.unstable_mockModule('../../../middleware/auth.js', () => ({
  requireAuth: (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    req.user = { id: 'user-1', email: 'user@test.com', tier: 'AMATEUR', isBanned: false };
    next();
  }
}));

jest.unstable_mockModule('../../../utils/redis.js', () => ({
  default: {},
  isRedisReady: jest.fn().mockReturnValue(true)
}));

const logger = (await import('../../../utils/logger.js')).default;
jest.spyOn(logger, 'info').mockImplementation(() => {});
jest.spyOn(logger, 'warn').mockImplementation(() => {});
jest.spyOn(logger, 'error').mockImplementation(() => {});

const { default: app } = await import('../../../app.js');
const { default: request } = await import('supertest');

const seedRow = (overrides = {}) => ({
  id: 'player-2',
  username: 'seed_dev02',
  displayName: 'seed-dev-02',
  avatar: 'avatar_01',
  tier: 'MASTER',
  isBanned: false,
  playerStats: {
    rating: 1435,
    wins: 6,
    losses: 3,
    draws: 1,
    totalMatches: 10
  },
  email: 'should@never.leak',
  fullName: 'Should Not Leak',
  phone: '+1555000',
  passwordHash: 'hashed',
  address: 'secret',
  dateOfBirth: new Date('2000-01-01'),
  ...overrides
});

describe('Player directory (search + public profile)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects requests without an authenticated session', async () => {
    const res = await request(app).get('/api/v1/players/search?username=ab');
    expect(res.status).toBe(401);
  });

  it('requires at least 2 characters so the directory cannot be enumerated', async () => {
    const res = await request(app)
      .get('/api/v1/players/search?username=a')
      .set('Authorization', 'Bearer token');
    expect(res.status).toBe(400);
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });

  it('searches by username or display name, excluding self and banned users', async () => {
    mockPrisma.user.findMany.mockResolvedValue([]);
    const res = await request(app)
      .get('/api/v1/players/search?username=SEED')
      .set('Authorization', 'Bearer token');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { players: [] } });
    expect(mockPrisma.user.findMany).toHaveBeenCalledWith({
      where: {
        id: { not: 'user-1' },
        isBanned: false,
        OR: [
          { username: { contains: 'SEED', mode: 'insensitive' } },
          { displayName: { contains: 'SEED', mode: 'insensitive' } }
        ]
      },
      select: expect.objectContaining({
        id: true,
        username: true,
        displayName: true,
        avatar: true,
        tier: true,
        isBanned: true
      }),
      orderBy: { username: 'asc' },
      take: 10
    });
  });

  it('caps the result page at 20 rows and rejects oversized terms', async () => {
    mockPrisma.user.findMany.mockResolvedValue([]);
    await request(app)
      .get('/api/v1/players/search?username=ab&limit=9999')
      .set('Authorization', 'Bearer token');
    expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20 })
    );
    const long = await request(app)
      .get(`/api/v1/players/search?username=${'x'.repeat(81)}`)
      .set('Authorization', 'Bearer token');
    expect(long.status).toBe(400);
  });

  it('never returns contact, legal-name, credential or verification fields', async () => {
    mockPrisma.user.findMany.mockResolvedValue([seedRow()]);
    const res = await request(app)
      .get('/api/v1/players/search?username=seed')
      .set('Authorization', 'Bearer token');
    expect(res.status).toBe(200);
    const player = res.body.data.players[0];
    expect(player).toEqual({
      id: 'player-2',
      username: 'seed_dev02',
      displayName: 'seed-dev-02',
      avatar: 'avatar_01',
      tier: 'MASTER',
      rating: 1435,
      wins: 6,
      losses: 3,
      draws: 1,
      totalMatches: 10,
      winRate: 60
    });
    expect(player).not.toHaveProperty('email');
    expect(player).not.toHaveProperty('fullName');
    expect(player).not.toHaveProperty('phone');
    expect(player).not.toHaveProperty('passwordHash');
    expect(player).not.toHaveProperty('address');
    expect(player).not.toHaveProperty('dateOfBirth');
    expect(player).not.toHaveProperty('isBanned');
  });

  it('returns a null win rate while a player has no recorded matches', async () => {
    mockPrisma.user.findMany.mockResolvedValue([
      seedRow({ playerStats: { rating: 1200, wins: 0, losses: 0, draws: 0, totalMatches: 0 } })
    ]);
    const res = await request(app)
      .get('/api/v1/players/search?username=seed')
      .set('Authorization', 'Bearer token');
    expect(res.body.data.players[0].winRate).toBeNull();
  });

  it('exposes a public profile by id', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(seedRow());
    const res = await request(app)
      .get('/api/v1/players/player-2')
      .set('Authorization', 'Bearer token');
    expect(res.status).toBe(200);
    expect(res.body.data.player.username).toBe('seed_dev02');
    expect(res.body.data.player).not.toHaveProperty('fullName');
    expect(mockPrisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'player-2', isBanned: false }
      })
    );
  });

  it('returns 404 for an unknown or invisible player', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(null);
    const res = await request(app)
      .get('/api/v1/players/nope')
      .set('Authorization', 'Bearer token');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Player not found');
  });
});