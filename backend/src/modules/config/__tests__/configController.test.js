import { jest } from '@jest/globals';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.REDIS_URL = '';
process.env.JWT_SECRET = 'unittest-admin-secret-config';

const mockPrisma = {
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
  adminRole: {
    findUnique: jest.fn()
  },
  adminAuditLog: {
    create: jest.fn().mockResolvedValue({ id: 'audit-log-1' })
  },
  platformConfigVersion: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    upsert: jest.fn(),
    delete: jest.fn()
  },
  platformSettings: {
    upsert: jest.fn()
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
const { DEFAULT_CONFIG_PAYLOAD } = await import('../schema.js');
const { generateChecksum } = await import('../canonicalJson.js');

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
  tier: 'unverified',
  isBanned: false,
  isAdmin: true
};

const asRole = async (name) => {
  mockPrisma.adminRoleAssignment.findMany.mockResolvedValue([{ role: { name } }]);
  return (await AuthService.issueTokens('caller-admin')).accessToken;
};

describe('Config API Endpoints (Integration)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.user.findUnique.mockResolvedValue(adminUser);
  });

  describe('GET /api/v1/admin/config/active', () => {
    it('returns 200 with the active configuration when authorized', async () => {
      const activeRow = {
        id: 'cfg-1',
        version: 1,
        status: 'ACTIVE',
        payload: DEFAULT_CONFIG_PAYLOAD,
        checksum: generateChecksum(DEFAULT_CONFIG_PAYLOAD),
        changeReason: 'Initial baseline',
        isRestricted: false,
        modifiedDomains: [],
        createdAt: new Date()
      };
      mockPrisma.platformConfigVersion.findFirst.mockResolvedValueOnce(activeRow);

      const token = await asRole('SUPER_ADMIN');
      const res = await request(app)
        .get('/api/v1/admin/config/active')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.config).toBeDefined();
      expect(res.body.config.version).toBe(1);
    });

    it('returns 403 when user lacks config.read permission (e.g. SUPPORT)', async () => {
      const token = await asRole('SUPPORT');
      const res = await request(app)
        .get('/api/v1/admin/config/active')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/insufficient admin permission/i);
    });
  });

  describe('GET /api/v1/admin/config/versions', () => {
    it('returns paginated version history', async () => {
      const versions = [
        { id: 'cfg-2', version: 2, status: 'DRAFT', changeReason: 'Draft 2' },
        { id: 'cfg-1', version: 1, status: 'ACTIVE', changeReason: 'Initial' }
      ];
      mockPrisma.platformConfigVersion.findMany.mockResolvedValueOnce(versions);
      mockPrisma.platformConfigVersion.count.mockResolvedValueOnce(2);

      const token = await asRole('SUPER_ADMIN');
      const res = await request(app)
        .get('/api/v1/admin/config/versions?page=1&limit=10')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.versions).toHaveLength(2);
      expect(res.body.total).toBe(2);
    });
  });

  describe('GET /api/v1/admin/config/versions/:version', () => {
    it('returns 200 with full version payload and checksum verification', async () => {
      const versionRow = {
        id: 'cfg-1',
        version: 1,
        status: 'ACTIVE',
        payload: DEFAULT_CONFIG_PAYLOAD,
        checksum: generateChecksum(DEFAULT_CONFIG_PAYLOAD)
      };
      mockPrisma.platformConfigVersion.findUnique.mockResolvedValueOnce(versionRow);

      const token = await asRole('SUPER_ADMIN');
      const res = await request(app)
        .get('/api/v1/admin/config/versions/1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.version.version).toBe(1);
    });

    it('returns 404 for a non-existent version', async () => {
      mockPrisma.platformConfigVersion.findUnique.mockResolvedValueOnce(null);

      const token = await asRole('SUPER_ADMIN');
      const res = await request(app)
        .get('/api/v1/admin/config/versions/999')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/i);
    });
  });

  describe('POST /api/v1/admin/config/drafts/validate', () => {
    it('returns valid: true with checksum for valid candidate payload', async () => {
      mockPrisma.platformConfigVersion.findFirst.mockResolvedValueOnce({
        id: 'active-1',
        version: 1,
        status: 'ACTIVE',
        payload: DEFAULT_CONFIG_PAYLOAD
      });

      const token = await asRole('SUPER_ADMIN');
      const res = await request(app)
        .post('/api/v1/admin/config/drafts/validate')
        .set('Authorization', `Bearer ${token}`)
        .send({ payload: DEFAULT_CONFIG_PAYLOAD });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.checksum).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns valid: false with issues array for invalid candidate payload', async () => {
      const invalid = structuredClone(DEFAULT_CONFIG_PAYLOAD);
      invalid.financial.commissionPercent = 99; // Exceeds max 25

      const token = await asRole('SUPER_ADMIN');
      const res = await request(app)
        .post('/api/v1/admin/config/drafts/validate')
        .set('Authorization', `Bearer ${token}`)
        .send({ payload: invalid });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.errors.length).toBeGreaterThan(0);
    });
  });

  describe('POST /api/v1/admin/config/drafts', () => {
    it('creates a draft successfully when authorized (SUPER_ADMIN or FINANCE)', async () => {
      mockPrisma.platformConfigVersion.findFirst.mockResolvedValueOnce({
        id: 'active-1',
        version: 1,
        status: 'ACTIVE',
        payload: DEFAULT_CONFIG_PAYLOAD
      });
      mockPrisma.platformConfigVersion.create.mockResolvedValueOnce({
        id: 'draft-created-1',
        version: 2,
        status: 'DRAFT',
        changeReason: 'Legitimate operational adjustment',
        isRestricted: false,
        modifiedDomains: ['GAME']
      });

      const token = await asRole('SUPER_ADMIN');
      const res = await request(app)
        .post('/api/v1/admin/config/drafts')
        .set('Authorization', `Bearer ${token}`)
        .send({
          changeReason: 'Legitimate operational adjustment',
          payload: DEFAULT_CONFIG_PAYLOAD
        });

      expect(res.status).toBe(201);
      expect(res.body.draft).toBeDefined();
      expect(res.body.draft.version).toBe(2);
    });

    it('returns 400 if changeReason is missing or too short', async () => {
      const token = await asRole('SUPER_ADMIN');
      const res = await request(app)
        .post('/api/v1/admin/config/drafts')
        .set('Authorization', `Bearer ${token}`)
        .send({
          changeReason: 'bad',
          payload: DEFAULT_CONFIG_PAYLOAD
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/change reason.*required/i);
    });

    it('returns 403 when attempted by READ_ONLY_AUDITOR', async () => {
      const token = await asRole('READ_ONLY_AUDITOR');
      const res = await request(app)
        .post('/api/v1/admin/config/drafts')
        .set('Authorization', `Bearer ${token}`)
        .send({
          changeReason: 'Audit proposal attempt',
          payload: DEFAULT_CONFIG_PAYLOAD
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/insufficient permission/i);
    });

    it('enforces server-side domain ownership: blocks GAME_OPERATIONS from proposing financial modifications', async () => {
      const financialModifiedPayload = structuredClone(DEFAULT_CONFIG_PAYLOAD);
      financialModifiedPayload.financial.commissionPercent = 15;

      mockPrisma.platformConfigVersion.findFirst.mockResolvedValueOnce({
        id: 'active-1',
        version: 1,
        status: 'ACTIVE',
        payload: DEFAULT_CONFIG_PAYLOAD
      });

      const token = await asRole('GAME_OPERATIONS');
      const res = await request(app)
        .post('/api/v1/admin/config/drafts')
        .set('Authorization', `Bearer ${token}`)
        .send({
          changeReason: 'Attempting cross-domain financial modification',
          payload: financialModifiedPayload
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/insufficient permission to propose changes for domain.*FINANCIAL/i);
    });
  });

  describe('PATCH /api/v1/admin/config/drafts/:id', () => {
    it('updates a draft when status is DRAFT', async () => {
      mockPrisma.platformConfigVersion.findUnique.mockResolvedValueOnce({
        id: 'draft-1',
        version: 2,
        status: 'DRAFT',
        payload: DEFAULT_CONFIG_PAYLOAD
      });
      mockPrisma.platformConfigVersion.findFirst.mockResolvedValueOnce({
        id: 'active-1',
        version: 1,
        status: 'ACTIVE',
        payload: DEFAULT_CONFIG_PAYLOAD
      });
      mockPrisma.platformConfigVersion.update.mockResolvedValueOnce({
        id: 'draft-1',
        version: 2,
        status: 'DRAFT',
        changeReason: 'Revised reason'
      });

      const token = await asRole('SUPER_ADMIN');
      const res = await request(app)
        .patch('/api/v1/admin/config/drafts/draft-1')
        .set('Authorization', `Bearer ${token}`)
        .send({
          changeReason: 'Revised reason'
        });

      expect(res.status).toBe(200);
      expect(res.body.draft.changeReason).toBe('Revised reason');
    });

    it('returns 409 when attempting to edit an ACTIVE version (immutability invariant)', async () => {
      mockPrisma.platformConfigVersion.findUnique.mockResolvedValueOnce({
        id: 'active-1',
        version: 1,
        status: 'ACTIVE',
        payload: DEFAULT_CONFIG_PAYLOAD
      });

      const token = await asRole('SUPER_ADMIN');
      const res = await request(app)
        .patch('/api/v1/admin/config/drafts/active-1')
        .set('Authorization', `Bearer ${token}`)
        .send({
          changeReason: 'Cannot mutate active'
        });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/cannot be modified/i);
    });
  });

  describe('DELETE /api/v1/admin/config/drafts/:id', () => {
    it('deletes a draft and returns confirmation', async () => {
      mockPrisma.platformConfigVersion.findUnique.mockResolvedValueOnce({
        id: 'draft-del-1',
        version: 3,
        status: 'DRAFT'
      });
      mockPrisma.platformConfigVersion.delete.mockResolvedValueOnce({});

      const token = await asRole('SUPER_ADMIN');
      const res = await request(app)
        .delete('/api/v1/admin/config/drafts/draft-del-1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);
      expect(res.body.draftId).toBe('draft-del-1');
    });

    it('returns 409 if version is not DRAFT (cannot delete active/superseded versions)', async () => {
      mockPrisma.platformConfigVersion.findUnique.mockResolvedValueOnce({
        id: 'cfg-active',
        version: 1,
        status: 'ACTIVE'
      });

      const token = await asRole('SUPER_ADMIN');
      const res = await request(app)
        .delete('/api/v1/admin/config/drafts/cfg-active')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/only DRAFT versions can be discarded/i);
    });
  });
});
