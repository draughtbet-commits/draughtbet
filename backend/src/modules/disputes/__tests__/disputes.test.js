import { jest } from '@jest/globals';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.REDIS_URL = '';
process.env.JWT_SECRET = 'unittest-disputes-secret';

const mockPrisma = {
  $transaction: jest.fn(),
  user: {
    findUnique: jest.fn(),
    findMany: jest.fn()
  },
  match: {
    findUnique: jest.fn()
  },
  matchParticipant: {
    findUnique: jest.fn()
  },
  disputeCase: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn()
  },
  disputeEvidence: {
    create: jest.fn()
  },
  idempotencyRecord: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn()
  },
  adminRoleAssignment: {
    findMany: jest.fn()
  },
  userSession: {
    create: jest.fn().mockResolvedValue({ id: 'sess-1' }),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn()
  },
  securityEvent: {
    create: jest.fn()
  }
};

jest.unstable_mockModule('../../../utils/db.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.unstable_mockModule('../../audit/service.js', () => ({
  recordAdminAction: jest.fn().mockResolvedValue({ id: 'log-1' }),
  auditFromRequest: jest.fn().mockResolvedValue({ id: 'log-1' }),
  AUDIT_OUTCOMES: ['SUCCESS', 'FAILURE', 'DENIED']
}));

const { default: express } = await import('express');
const { default: request } = await import('supertest');
const { disputeUserRouter } = await import('../controller.js');
const { AuthService } = await import('../../auth/service.js');

const app = express();
app.use(express.json());
app.use('/api/v1/matches', disputeUserRouter);
app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
});

const mockRedis = { set: jest.fn(), get: jest.fn(), del: jest.fn(), scanStream: jest.fn() };
mockRedis.get.mockResolvedValue('ng');
AuthService.__setPrisma(mockPrisma);
AuthService.__setRedis(mockRedis);

const caller = { id: 'u1', email: 'player@x', tier: 'unverified', isBanned: false, isAdmin: false };

// requireAuth resolves the caller by token userId; return an identity that
// matches the token so the participant checks see the right uuid.
mockPrisma.user.findUnique.mockImplementation(async ({ where }) => ({
  id: where.id,
  email: `${where.id}@x`,
  tier: 'unverified',
  isBanned: false,
  isAdmin: false
}));

const terminalMatch = (overrides = {}) => ({
  id: 'm1',
  status: 'COMPLETED',
  endedAt: new Date(),
  createdAt: new Date('2026-01-01T00:00:00Z'),
  playerLightId: 'u1',
  playerDarkId: 'u2',
  ...overrides
});

const OP_KEY = 'op-key-0001';

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.user.findUnique.mockImplementation(async ({ where }) => ({
    id: where.id,
    email: `${where.id}@x`,
    tier: 'unverified',
    isBanned: false,
    isAdmin: false
  }));
  mockPrisma.match.findUnique.mockResolvedValue(terminalMatch());
  mockPrisma.matchParticipant.findUnique.mockResolvedValue(null);
  mockPrisma.disputeCase.findFirst.mockResolvedValue(null);
  mockPrisma.disputeCase.create.mockResolvedValue({ id: 'dc1', status: 'OPEN', matchId: 'm1' });
  mockPrisma.disputeEvidence.create.mockImplementation(async ({ data }) => ({ id: 'ev-1', ...data }));
  mockPrisma.idempotencyRecord.findUnique.mockResolvedValue(null);
  mockPrisma.idempotencyRecord.create.mockResolvedValue({ id: 'ir-1', result: null });
  mockPrisma.$transaction.mockImplementation(async (fn) => (typeof fn === 'function' ? fn(mockPrisma) : undefined));
});

const tokenFor = async (userId) => (await AuthService.issueTokens(userId)).accessToken;

describe('POST /matches/:matchId/disputes (participant raise)', () => {
  it('creates an OPEN dispute with category, message and evidence refs', async () => {
    const token = await tokenFor('u1');

    const res = await request(app)
      .post('/api/v1/matches/m1/disputes')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', OP_KEY)
      .send({
        category: 'TECHNICAL_RESULT',
        message: 'Wrong winner was recorded',
        evidence: [
          { type: 'GAME_LOG', url: 's3://logs/m1/001' },
          { type: 'SCREENSHOT', url: 's3://shots/m1/001.png' }
        ]
      });

    expect(res.status).toBe(201);
    expect(res.body.disputeId).toBe('dc1');
    expect(res.body.status).toBe('OPEN');
    expect(mockPrisma.disputeCase.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ matchId: 'm1', raisedBy: 'u1', category: 'TECHNICAL_RESULT', reason: 'Wrong winner was recorded' })
    });
    expect(mockPrisma.disputeEvidence.create).toHaveBeenCalledTimes(2);
  });

  it('rejects a non-participant with DISPUTE_NOT_ELIGIBLE', async () => {
    // Caller u3 is neither light/dark nor a participant row.
    mockPrisma.match.findUnique.mockResolvedValue(
      terminalMatch({ playerLightId: 'u1', playerDarkId: 'u2' })
    );
    const token = await tokenFor('u3');

    const res = await request(app)
      .post('/api/v1/matches/m1/disputes')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', OP_KEY)
      .send({ message: 'Cheating' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('DISPUTE_NOT_ELIGIBLE');
    expect(mockPrisma.disputeCase.create).not.toHaveBeenCalled();
  });

  it('rejects a match that is still live', async () => {
    mockPrisma.match.findUnique.mockResolvedValue(terminalMatch({ status: 'IN_PLAY', endedAt: null }));
    const token = await tokenFor('u1');

    const res = await request(app)
      .post('/api/v1/matches/m1/disputes')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', OP_KEY)
      .send({ message: 'Cheating' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('DISPUTE_NOT_ELIGIBLE');
  });

  it('rejects a dispute raised after the window expired', async () => {
    mockPrisma.match.findUnique.mockResolvedValue(
      terminalMatch({ endedAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000) })
    );
    const token = await tokenFor('u1');

    const res = await request(app)
      .post('/api/v1/matches/m1/disputes')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', OP_KEY)
      .send({ message: 'Cheating' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DISPUTE_WINDOW_EXPIRED');
  });

  it('rejects a duplicate open dispute', async () => {
    mockPrisma.disputeCase.findFirst.mockResolvedValue({ id: 'dc-early', status: 'OPEN' });
    const token = await tokenFor('u1');

    const res = await request(app)
      .post('/api/v1/matches/m1/disputes')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', OP_KEY)
      .send({ message: 'Again' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_DISPUTE');
    expect(mockPrisma.disputeCase.create).not.toHaveBeenCalled();
  });

  it('requires a message body and an Idempotency-Key header', async () => {
    const token = await tokenFor('u1');

    const noMessage = await request(app)
      .post('/api/v1/matches/m1/disputes')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', OP_KEY)
      .send({ message: '   ' });
    expect(noMessage.status).toBe(400);

    const noKey = await request(app)
      .post('/api/v1/matches/m1/disputes')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Cheating' });
    expect(noKey.status).toBe(400);
    expect(noKey.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});