import { jest } from '@jest/globals';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.REDIS_URL = '';
process.env.JWT_SECRET = 'unittest-admin-secret-config';

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
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    upsert: jest.fn(),
    delete: jest.fn()
  },
  configApproval: {
    create: jest.fn(),
    findMany: jest.fn()
  },
  outboxEvent: {
    create: jest.fn().mockResolvedValue({ id: 'outbox-1' })
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
        changeReason: 'Initial bootstrap',
        createdAt: new Date().toISOString()
      };
      mockPrisma.platformConfigVersion.findFirst.mockResolvedValueOnce(activeRow);

      const token = await asRole('FINANCE');
      const res = await request(app)
        .get('/api/v1/admin/config/active')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.config).toBeDefined();
      expect(res.body.config.version).toBe(1);
      expect(res.body.config.checksum).toBe(activeRow.checksum);
    });

    it('returns 403 when user lacks config.read permission (e.g. SUPPORT)', async () => {
      const token = await asRole('SUPPORT');
      const res = await request(app)
        .get('/api/v1/admin/config/active')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/Insufficient admin permission/);
    });
  });

  describe('GET /api/v1/admin/config/versions', () => {
    it('returns paginated version history', async () => {
      const versions = [
        {
          id: 'v2',
          version: 2,
          status: 'DRAFT',
          checksum: 'abcd',
          changeReason: 'Test draft',
          authorId: 'caller-admin',
          author: { id: 'caller-admin', email: 'admin@draughtbet.com' }
        },
        {
          id: 'v1',
          version: 1,
          status: 'ACTIVE',
          checksum: '1234',
          changeReason: 'Bootstrap',
          authorId: 'caller-admin',
          author: { id: 'caller-admin', email: 'admin@draughtbet.com' }
        }
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
      expect(res.body.totalPages).toBe(1);
    });
  });

  describe('GET /api/v1/admin/config/versions/:version', () => {
    it('returns 200 with full version payload and checksum verification', async () => {
      const versionRow = {
        id: 'v1',
        version: 1,
        status: 'ACTIVE',
        payload: DEFAULT_CONFIG_PAYLOAD,
        checksum: generateChecksum(DEFAULT_CONFIG_PAYLOAD),
        author: { id: 'u1', email: 'u1@db.com' },
        approvals: []
      };
      mockPrisma.platformConfigVersion.findUnique.mockResolvedValueOnce(versionRow);

      const token = await asRole('READ_ONLY_AUDITOR');
      const res = await request(app)
        .get('/api/v1/admin/config/versions/1')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.version.version).toBe(1);
      expect(res.body.version.payload).toBeDefined();
    });

    it('returns 404 for a non-existent version', async () => {
      mockPrisma.platformConfigVersion.findUnique.mockResolvedValueOnce(null);

      const token = await asRole('SUPER_ADMIN');
      const res = await request(app)
        .get('/api/v1/admin/config/versions/999')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/);
    });
  });

  describe('POST /api/v1/admin/config/drafts/validate', () => {
    it('returns valid: true with checksum for valid candidate payload', async () => {
      mockPrisma.platformConfigVersion.findFirst.mockResolvedValueOnce({
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
      invalid.financial.commissionPercent = 99; // invalid

      const token = await asRole('SUPER_ADMIN');
      const res = await request(app)
        .post('/api/v1/admin/config/drafts/validate')
        .set('Authorization', `Bearer ${token}`)
        .send({ payload: invalid });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.errors).toBeDefined();
    });
  });

  describe('POST /api/v1/admin/config/drafts', () => {
    it('creates a draft successfully when authorized (SUPER_ADMIN or FINANCE)', async () => {
      mockPrisma.platformConfigVersion.findFirst
        .mockResolvedValueOnce({
          version: 1,
          status: 'ACTIVE',
          payload: DEFAULT_CONFIG_PAYLOAD,
          checksum: generateChecksum(DEFAULT_CONFIG_PAYLOAD)
        })
        .mockResolvedValueOnce({ version: 1 });

      const newDraft = {
        id: 'draft-created-1',
        version: 2,
        status: 'DRAFT',
        changeReason: 'Update game turn timers for speed matches',
        isRestricted: false,
        payload: DEFAULT_CONFIG_PAYLOAD,
        checksum: generateChecksum(DEFAULT_CONFIG_PAYLOAD)
      };
      mockPrisma.platformConfigVersion.create.mockResolvedValueOnce(newDraft);

      const token = await asRole('FINANCE');
      const res = await request(app)
        .post('/api/v1/admin/config/drafts')
        .set('Authorization', `Bearer ${token}`)
        .send({
          changeReason: 'Update game turn timers for speed matches',
          payload: DEFAULT_CONFIG_PAYLOAD
        });

      expect(res.status).toBe(201);
      expect(res.body.draft.id).toBe('draft-created-1');
      expect(res.body.draft.status).toBe('DRAFT');
    });

    it('returns 400 if changeReason is missing or too short', async () => {
      const token = await asRole('SUPER_ADMIN');
      const res = await request(app)
        .post('/api/v1/admin/config/drafts')
        .set('Authorization', `Bearer ${token}`)
        .send({
          changeReason: 'hi',
          payload: DEFAULT_CONFIG_PAYLOAD
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/change reason/i);
    });

    it('returns 403 when attempted by READ_ONLY_AUDITOR', async () => {
      const token = await asRole('READ_ONLY_AUDITOR');
      const res = await request(app)
        .post('/api/v1/admin/config/drafts')
        .set('Authorization', `Bearer ${token}`)
        .send({
          changeReason: 'Unauthorized draft attempt',
          payload: DEFAULT_CONFIG_PAYLOAD
        });

      expect(res.status).toBe(403);
    });

    it('enforces server-side domain ownership: blocks GAME_OPERATIONS from proposing financial modifications', async () => {
      mockPrisma.platformConfigVersion.findFirst.mockResolvedValue({
        version: 1,
        status: 'ACTIVE',
        payload: DEFAULT_CONFIG_PAYLOAD
      });

      const financialPayload = structuredClone(DEFAULT_CONFIG_PAYLOAD);
      financialPayload.financial.commissionPercent = 15;

      const token = await asRole('GAME_OPERATIONS');
      const res = await request(app)
        .post('/api/v1/admin/config/drafts')
        .set('Authorization', `Bearer ${token}`)
        .send({
          changeReason: 'Illegal financial modification attempt',
          payload: financialPayload
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/Insufficient permission to propose changes for domain\(s\): FINANCIAL/);
      expect(res.body.unauthorizedDomains).toContain('FINANCIAL');
    });
  });

  describe('PATCH /api/v1/admin/config/drafts/:id', () => {
    it('updates a draft when status is DRAFT', async () => {
      const draft = {
        id: 'draft-patch-1',
        version: 2,
        status: 'DRAFT',
        payload: DEFAULT_CONFIG_PAYLOAD,
        changeReason: 'Initial'
      };
      mockPrisma.platformConfigVersion.findUnique.mockResolvedValueOnce(draft);
      mockPrisma.platformConfigVersion.findFirst.mockResolvedValueOnce({
        version: 1,
        status: 'ACTIVE',
        payload: DEFAULT_CONFIG_PAYLOAD
      });
      mockPrisma.platformConfigVersion.update.mockResolvedValueOnce({
        ...draft,
        changeReason: 'Revised reason'
      });

      const token = await asRole('SUPER_ADMIN');
      const res = await request(app)
        .patch('/api/v1/admin/config/drafts/draft-patch-1')
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

  describe('POST /api/v1/admin/config/drafts/:id/submit', () => {
    it('submits a DRAFT for review returning 200 with PENDING_APPROVAL status', async () => {
      const draft = {
        id: 'draft-sub-1',
        version: 2,
        status: 'DRAFT',
        payload: DEFAULT_CONFIG_PAYLOAD,
        checksum: generateChecksum(DEFAULT_CONFIG_PAYLOAD),
        authorId: 'caller-admin'
      };
      mockPrisma.platformConfigVersion.findUnique.mockResolvedValueOnce(draft);
      mockPrisma.platformConfigVersion.update.mockResolvedValueOnce({
        ...draft,
        status: 'PENDING_APPROVAL'
      });

      const token = await asRole('SUPER_ADMIN');
      const res = await request(app)
        .post('/api/v1/admin/config/drafts/draft-sub-1/submit')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.version.status).toBe('PENDING_APPROVAL');
    });

    it('returns 409 if version is already submitted or not DRAFT', async () => {
      mockPrisma.platformConfigVersion.findUnique.mockResolvedValueOnce({
        id: 'draft-sub-1',
        version: 2,
        status: 'PENDING_APPROVAL',
        payload: DEFAULT_CONFIG_PAYLOAD,
        checksum: generateChecksum(DEFAULT_CONFIG_PAYLOAD)
      });

      const token = await asRole('SUPER_ADMIN');
      const res = await request(app)
        .post('/api/v1/admin/config/drafts/draft-sub-1/submit')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/only DRAFT configurations can be submitted/i);
    });
  });

  describe('POST /api/v1/admin/config/versions/:id/approve', () => {
    it('approves a submitted version with independent reviewer', async () => {
      const checksum = generateChecksum(DEFAULT_CONFIG_PAYLOAD);
      const version = {
        id: 'ver-appr-1',
        version: 2,
        status: 'PENDING_APPROVAL',
        authorId: 'other-author', // Different from caller-admin!
        payload: DEFAULT_CONFIG_PAYLOAD,
        checksum
      };
      mockPrisma.platformConfigVersion.findUnique.mockResolvedValueOnce(version);
      mockPrisma.configApproval.create.mockResolvedValueOnce({
        id: 'appr-1',
        status: 'APPROVED',
        checksum
      });
      mockPrisma.platformConfigVersion.update.mockResolvedValueOnce({
        ...version,
        status: 'APPROVED'
      });

      const token = await asRole('SUPER_ADMIN');
      const res = await request(app)
        .post('/api/v1/admin/config/versions/ver-appr-1/approve')
        .set('Authorization', `Bearer ${token}`)
        .send({ reviewNote: 'Looks great', checksum });

      expect(res.status).toBe(200);
      expect(res.body.version.status).toBe('APPROVED');
    });

    it('returns 403 when author attempts to self-approve', async () => {
      const checksum = generateChecksum(DEFAULT_CONFIG_PAYLOAD);
      const version = {
        id: 'ver-appr-1',
        version: 2,
        status: 'PENDING_APPROVAL',
        authorId: 'caller-admin', // Same as caller!
        payload: DEFAULT_CONFIG_PAYLOAD,
        checksum
      };
      mockPrisma.platformConfigVersion.findUnique.mockResolvedValueOnce(version);

      const token = await asRole('SUPER_ADMIN');
      const res = await request(app)
        .post('/api/v1/admin/config/versions/ver-appr-1/approve')
        .set('Authorization', `Bearer ${token}`)
        .send({ reviewNote: 'Self approving', checksum });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/author cannot approve their own configuration/i);
    });

    it('returns 409 when client checksum does not match server checksum', async () => {
      const checksum = generateChecksum(DEFAULT_CONFIG_PAYLOAD);
      const version = {
        id: 'ver-appr-1',
        version: 2,
        status: 'PENDING_APPROVAL',
        authorId: 'other-author',
        payload: DEFAULT_CONFIG_PAYLOAD,
        checksum
      };
      mockPrisma.platformConfigVersion.findUnique.mockResolvedValueOnce(version);

      const token = await asRole('SUPER_ADMIN');
      const res = await request(app)
        .post('/api/v1/admin/config/versions/ver-appr-1/approve')
        .set('Authorization', `Bearer ${token}`)
        .send({ reviewNote: 'Note', checksum: 'badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadb' });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/does not match/i);
    });
  });

  describe('POST /api/v1/admin/config/versions/:id/reject', () => {
    it('rejects a submitted version with mandatory reason', async () => {
      const checksum = generateChecksum(DEFAULT_CONFIG_PAYLOAD);
      const version = {
        id: 'ver-rej-1',
        version: 2,
        status: 'PENDING_APPROVAL',
        authorId: 'other-author',
        payload: DEFAULT_CONFIG_PAYLOAD,
        checksum
      };
      mockPrisma.platformConfigVersion.findUnique.mockResolvedValueOnce(version);
      mockPrisma.configApproval.create.mockResolvedValueOnce({
        id: 'appr-rej-1',
        status: 'REJECTED'
      });
      mockPrisma.platformConfigVersion.update.mockResolvedValueOnce({
        ...version,
        status: 'REJECTED'
      });

      const token = await asRole('SUPER_ADMIN');
      const res = await request(app)
        .post('/api/v1/admin/config/versions/ver-rej-1/reject')
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Inappropriate stake boundaries' });

      expect(res.status).toBe(200);
      expect(res.body.version.status).toBe('REJECTED');
    });

    it('returns 400 if reason is omitted or too short', async () => {
      const token = await asRole('SUPER_ADMIN');
      const res = await request(app)
        .post('/api/v1/admin/config/versions/ver-rej-1/reject')
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'no' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/minimum 5 characters/i);
    });
  });

  describe('POST /api/v1/admin/config/versions/:id/activate', () => {
    it('activates an APPROVED version and returns 200', async () => {
      const checksum = generateChecksum(DEFAULT_CONFIG_PAYLOAD);
      const version = {
        id: 'ver-act-1',
        version: 2,
        status: 'APPROVED',
        payload: DEFAULT_CONFIG_PAYLOAD,
        checksum,
        isRestricted: false,
        modifiedDomains: [],
        approvals: [
          {
            id: 'appr-1',
            status: 'APPROVED',
            checksum
          }
        ]
      };
      mockPrisma.platformConfigVersion.findUnique.mockResolvedValueOnce(version);
      mockPrisma.platformConfigVersion.update.mockResolvedValueOnce({
        ...version,
        status: 'ACTIVE',
        activatedAt: new Date(),
        activatedById: 'caller-admin'
      });

      const token = await asRole('SUPER_ADMIN');
      const res = await request(app)
        .post('/api/v1/admin/config/versions/ver-act-1/activate')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.version.status).toBe('ACTIVE');
    });

    it('returns 409 if version is not APPROVED', async () => {
      const checksum = generateChecksum(DEFAULT_CONFIG_PAYLOAD);
      const version = {
        id: 'ver-act-1',
        version: 2,
        status: 'DRAFT',
        payload: DEFAULT_CONFIG_PAYLOAD,
        checksum,
        approvals: []
      };
      mockPrisma.platformConfigVersion.findUnique.mockResolvedValueOnce(version);

      const token = await asRole('SUPER_ADMIN');
      const res = await request(app)
        .post('/api/v1/admin/config/versions/ver-act-1/activate')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/only APPROVED configurations can be activated/i);
    });
  });

  describe('POST /api/v1/admin/config/versions/:id/rollback', () => {
    it('creates a rollback draft version and returns 201', async () => {
      const checksum = generateChecksum(DEFAULT_CONFIG_PAYLOAD);
      const historical = {
        id: 'ver-hist-1',
        version: 1,
        status: 'SUPERSEDED',
        payload: DEFAULT_CONFIG_PAYLOAD,
        checksum
      };
      mockPrisma.platformConfigVersion.findUnique.mockResolvedValueOnce(historical);
      mockPrisma.platformConfigVersion.create.mockResolvedValueOnce({
        id: 'ver-rollback-3',
        version: 3,
        status: 'DRAFT',
        rolledBackFrom: 1,
        payload: DEFAULT_CONFIG_PAYLOAD,
        checksum
      });

      const token = await asRole('SUPER_ADMIN');
      const res = await request(app)
        .post('/api/v1/admin/config/versions/1/rollback')
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Rollback due to incident' });

      expect(res.status).toBe(201);
      expect(res.body.version.version).toBe(3);
      expect(res.body.version.rolledBackFrom).toBe(1);
    });
  });
});
