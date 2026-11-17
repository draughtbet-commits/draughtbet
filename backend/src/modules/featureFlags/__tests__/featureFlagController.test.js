import { jest, describe, it, expect, beforeEach } from '@jest/globals';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.REDIS_URL = '';
process.env.JWT_SECRET = 'unittest-admin-secret-feature-flags';

const mockPrisma = {
  $transaction: jest.fn(async (cb) => cb(mockPrisma)),
  user: {
    findUnique: jest.fn()
  },
  userSession: {
    create: jest.fn().mockResolvedValue({ id: 's1' }),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn()
  },
  adminRoleAssignment: {
    findMany: jest.fn()
  },
  adminAuditLog: {
    create: jest.fn().mockResolvedValue({ id: 'audit-log-1' }),
    findMany: jest.fn(),
    count: jest.fn()
  },
  featureFlag: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn()
  },
  outboxEvent: {
    create: jest.fn().mockResolvedValue({ id: 'outbox-1' })
  }
};

jest.unstable_mockModule('../../../utils/db.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.unstable_mockModule('../../../sockets/index.js', () => ({
  getIO: () => null
}));
jest.unstable_mockModule('../../payment/PaystackGateway.js', () => ({
  PaystackGateway: jest.fn()
}));
jest.unstable_mockModule('../../payment/FlutterwaveGateway.js', () => ({
  FlutterwaveGateway: jest.fn()
}));

const { default: express } = await import('express');
const { default: request } = await import('supertest');
const { adminRouter } = await import('../../admin/controller.js');
const { AuthService } = await import('../../auth/service.js');

const app = express();
app.use(express.json());
app.use('/api/v1/admin', adminRouter);
app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
});

const mockRedis = { set: jest.fn(), get: jest.fn(), del: jest.fn() };
mockRedis.get.mockResolvedValue('ng');

AuthService.__setPrisma(mockPrisma);
AuthService.__setRedis(mockRedis);

const adminUser = {
  id: 'caller-admin',
  email: 'admin@draughtbet.com',
  tier: 'AMATEUR',
  isBanned: false,
  isAdmin: true
};

const asRole = async (name) => {
  mockPrisma.adminRoleAssignment.findMany.mockResolvedValue([{ role: { name } }]);
  return (await AuthService.issueTokens('caller-admin')).accessToken;
};

describe('Feature Flags Admin API Endpoints (Integration)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.user.findUnique.mockResolvedValue(adminUser);
  });

  describe('GET /api/v1/admin/feature-flags', () => {
    it('returns 200 with flags and visibility metadata for any admin role with FLAGS_READ', async () => {
      mockPrisma.featureFlag.findMany.mockResolvedValueOnce([
        {
          id: 'ff-1',
          key: 'callout_challenges_enabled',
          name: 'High-Stakes Call-Out Challenges',
          enabled: true,
          rolloutPercentage: 100,
          allowedTiers: ['MASTER', 'PRO'],
          allowedRoles: ['SUPER_ADMIN', 'GAME_OPERATIONS'],
          isKillSwitch: true,
          metadata: null
        }
      ]);

      const token = await asRole('READ_ONLY_AUDITOR');
      const res = await request(app)
        .get('/api/v1/admin/feature-flags')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.flags).toHaveLength(1);
      expect(res.body.flags[0].key).toBe('callout_challenges_enabled');
      expect(res.body.flags[0].adminVisibility.visible).toBe(false);
      expect(res.body.flags[0].adminVisibility.grantsPermissions).toBe(false);
    });
  });

  describe('POST /api/v1/admin/feature-flags', () => {
    it('allows SUPER_ADMIN (FLAGS_MANAGE) to create a feature flag', async () => {
      mockPrisma.featureFlag.findUnique.mockResolvedValueOnce(null);
      mockPrisma.featureFlag.create.mockImplementationOnce(async ({ data }) => ({
        id: 'ff-created-1',
        ...data,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }));

      const token = await asRole('SUPER_ADMIN');
      const res = await request(app)
        .post('/api/v1/admin/feature-flags')
        .set('Authorization', `Bearer ${token}`)
        .send({
          key: 'match_replay_v2',
          name: 'Match Replay V2',
          description: 'Gradual rollout of Replay V2',
          enabled: true,
          rolloutPercentage: 25,
          allowedTiers: ['MASTER', 'PRO'],
          allowedRoles: ['SUPER_ADMIN', 'GAME_OPERATIONS'],
          isKillSwitch: false,
          changeReason: 'Enable 25% canary rollout for Master and Pro players'
        });

      expect(res.status).toBe(201);
      expect(res.body.flag.key).toBe('match_replay_v2');
      expect(res.body.flag.rolloutPercentage).toBe(25);
    });

    it('denies non-SUPER_ADMIN roles (e.g. SUPPORT, GAME_OPERATIONS, FINANCE) from creating flags with 403', async () => {
      for (const role of ['SUPPORT', 'GAME_OPERATIONS', 'FINANCE', 'RISK_COMPLIANCE', 'READ_ONLY_AUDITOR']) {
        const token = await asRole(role);
        const res = await request(app)
          .post('/api/v1/admin/feature-flags')
          .set('Authorization', `Bearer ${token}`)
          .send({
            key: 'unauthorized_flag',
            name: 'Unauthorized Flag',
            changeReason: 'Attempt creation without FLAGS_MANAGE'
          });

        expect(res.status).toBe(403);
      }
    });
  });

  describe('POST /api/v1/admin/feature-flags/:key/kill-switch', () => {
    it('allows GAME_OPERATIONS and RISK_COMPLIANCE (FLAGS_KILLSWITCH) to trip a kill switch', async () => {
      mockPrisma.featureFlag.findUnique.mockResolvedValue({
        id: 'ff-ks-1',
        key: 'live_matchmaking_queue',
        name: 'Live Matchmaking Queue',
        enabled: true,
        rolloutPercentage: 100,
        allowedTiers: ['AMATEUR', 'MASTER', 'PRO'],
        allowedRoles: ['SUPER_ADMIN', 'GAME_OPERATIONS'],
        isKillSwitch: true
      });
      mockPrisma.featureFlag.update.mockImplementation(async ({ data }) => ({
        id: 'ff-ks-1',
        key: 'live_matchmaking_queue',
        name: 'Live Matchmaking Queue',
        isKillSwitch: true,
        ...data
      }));

      const token = await asRole('GAME_OPERATIONS');
      const res = await request(app)
        .post('/api/v1/admin/feature-flags/live_matchmaking_queue/kill-switch')
        .set('Authorization', `Bearer ${token}`)
        .send({
          enabled: false,
          reason: 'Pause matchmaking queue during game engine incident'
        });

      expect(res.status).toBe(200);
      expect(res.body.flag.enabled).toBe(false);
    });

    it('denies SUPPORT, FINANCE, and READ_ONLY_AUDITOR from triggering kill switches with 403', async () => {
      for (const role of ['SUPPORT', 'FINANCE', 'READ_ONLY_AUDITOR']) {
        const token = await asRole(role);
        const res = await request(app)
          .post('/api/v1/admin/feature-flags/live_matchmaking_queue/kill-switch')
          .set('Authorization', `Bearer ${token}`)
          .send({
            enabled: false,
            reason: 'Unauthorized kill switch attempt'
          });

        expect(res.status).toBe(403);
      }
    });
  });

  describe('POST /api/v1/admin/feature-flags/:key/evaluate', () => {
    it('returns deterministic evaluation result for a userId and userTier', async () => {
      mockPrisma.featureFlag.findUnique.mockResolvedValue({
        id: 'ff-eval-1',
        key: 'enhanced_match_replay_viewer',
        name: 'Enhanced Match Replay Viewer',
        enabled: true,
        rolloutPercentage: 100,
        allowedTiers: ['MASTER', 'PRO'],
        allowedRoles: ['SUPER_ADMIN', 'GAME_OPERATIONS'],
        isKillSwitch: false
      });

      const token = await asRole('GAME_OPERATIONS');
      const res = await request(app)
        .post('/api/v1/admin/feature-flags/enhanced_match_replay_viewer/evaluate')
        .set('Authorization', `Bearer ${token}`)
        .send({
          userId: 'player-pro-1',
          userTier: 'PRO'
        });

      expect(res.status).toBe(200);
      expect(res.body.evaluation.enabled).toBe(true);
      expect(res.body.evaluation.reason).toBe('FULL_ROLLOUT');
      expect(res.body.evaluation.grantsPermissions).toBe(false);
      expect(res.body.evaluation.rbacAuthoritative).toBe(true);
    });
  });
});
