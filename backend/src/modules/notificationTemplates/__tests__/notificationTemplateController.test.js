import { jest, describe, it, expect, beforeEach } from '@jest/globals';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.REDIS_URL = '';
process.env.JWT_SECRET = 'unittest-admin-secret-notification-templates';

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
    create: jest.fn().mockResolvedValue({ id: 'audit-log-tpl-1' }),
    findMany: jest.fn(),
    count: jest.fn()
  },
  notificationTemplate: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn()
  },
  outboxEvent: {
    create: jest.fn().mockResolvedValue({ id: 'outbox-tpl-1' })
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

describe('Notification Templates Admin API Endpoints (Integration)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.user.findUnique.mockResolvedValue(adminUser);
  });

  describe('GET /api/v1/admin/notification-templates/channels', () => {
    it('returns honest runtime channel capabilities for authorized CONFIG_READ roles', async () => {
      const token = await asRole('READ_ONLY_AUDITOR');
      const res = await request(app)
        .get('/api/v1/admin/notification-templates/channels')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.channels).toHaveLength(3);
      const inApp = res.body.channels.find((c) => c.channel === 'IN_APP');
      const email = res.body.channels.find((c) => c.channel === 'EMAIL');
      expect(inApp.implemented).toBe(true);
      expect(email.implemented).toBe(false);
    });
  });

  describe('GET /api/v1/admin/notification-templates', () => {
    it('lists templates with channelDetails and systemRequiredVariables', async () => {
      mockPrisma.notificationTemplate.findMany.mockResolvedValueOnce([
        {
          id: 'tpl-1',
          code: 'DEPOSIT_CONFIRMED',
          title: 'Deposit Confirmed',
          bodyTemplate: 'Your deposit of {{amount}} has been credited.',
          category: 'TRANSACTIONAL',
          channels: ['IN_APP', 'PUSH'],
          variables: ['amount'],
          isActive: true,
          version: 1
        }
      ]);

      const token = await asRole('FINANCE');
      const res = await request(app)
        .get('/api/v1/admin/notification-templates')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.templates).toHaveLength(1);
      expect(res.body.templates[0].code).toBe('DEPOSIT_CONFIRMED');
      expect(res.body.templates[0].systemRequiredVariables).toEqual(['amount']);
    });

    it('returns 403 for roles without CONFIG_READ (e.g. SUPPORT)', async () => {
      const token = await asRole('SUPPORT');
      const res = await request(app)
        .get('/api/v1/admin/notification-templates')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/v1/admin/notification-templates & PATCH /:codeOrId', () => {
    it('allows SUPER_ADMIN (TEMPLATES_MANAGE) to create and update templates', async () => {
      mockPrisma.notificationTemplate.findUnique.mockResolvedValueOnce(null);
      mockPrisma.notificationTemplate.create.mockImplementationOnce(async ({ data }) => ({
        id: 'tpl-new-1',
        ...data,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }));

      const token = await asRole('SUPER_ADMIN');
      const createRes = await request(app)
        .post('/api/v1/admin/notification-templates')
        .set('Authorization', `Bearer ${token}`)
        .send({
          code: 'KYC_VERIFIED_NOTICE',
          title: 'Account Verified',
          bodyTemplate: 'Hello {{playerName}}, your KYC verification is complete.',
          category: 'COMPLIANCE',
          channels: ['IN_APP'],
          variables: ['playerName'],
          changeReason: 'Create KYC verification completion notice'
        });

      expect(createRes.status).toBe(201);
      expect(createRes.body.template.code).toBe('KYC_VERIFIED_NOTICE');
      expect(createRes.body.template.version).toBe(1);

      // Update template -> increments version to 2
      mockPrisma.notificationTemplate.findUnique.mockResolvedValueOnce({
        id: 'tpl-new-1',
        code: 'KYC_VERIFIED_NOTICE',
        title: 'Account Verified',
        bodyTemplate: 'Hello {{playerName}}, your KYC verification is complete.',
        category: 'COMPLIANCE',
        channels: ['IN_APP'],
        variables: ['playerName'],
        isActive: true,
        version: 1
      });
      mockPrisma.notificationTemplate.update.mockImplementationOnce(async ({ data }) => ({
        id: 'tpl-new-1',
        code: 'KYC_VERIFIED_NOTICE',
        ...data,
        updatedAt: new Date().toISOString()
      }));

      const patchRes = await request(app)
        .patch('/api/v1/admin/notification-templates/KYC_VERIFIED_NOTICE')
        .set('Authorization', `Bearer ${token}`)
        .send({
          bodyTemplate: 'Hello {{playerName}}, your KYC verification was approved on {{verifiedDate}}.',
          variables: ['playerName', 'verifiedDate'],
          changeReason: 'Include verification date in KYC notice'
        });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.template.version).toBe(2);
    });

    it('denies non-SUPER_ADMIN roles from creating or editing templates with 403', async () => {
      for (const role of ['FINANCE', 'RISK_COMPLIANCE', 'SUPPORT', 'GAME_OPERATIONS', 'READ_ONLY_AUDITOR']) {
        const token = await asRole(role);
        const res = await request(app)
          .post('/api/v1/admin/notification-templates')
          .set('Authorization', `Bearer ${token}`)
          .send({
            code: 'UNAUTHORIZED_TPL',
            title: 'Unauthorized',
            bodyTemplate: 'Hello {{user}}',
            variables: ['user'],
            changeReason: 'Unauthorized template mutation'
          });

        expect(res.status).toBe(403);
      }
    });
  });

  describe('POST /api/v1/admin/notification-templates/preview & /:codeOrId/preview', () => {
    it('renders preview safely and returns 400 with missingVariables when required variables are missing', async () => {
      const token = await asRole('SUPER_ADMIN');

      const okRes = await request(app)
        .post('/api/v1/admin/notification-templates/preview')
        .set('Authorization', `Bearer ${token}`)
        .send({
          code: 'DEPOSIT_CONFIRMED',
          title: 'Deposit Confirmed',
          bodyTemplate: 'Your deposit of {{amount}} is complete.',
          variables: ['amount'],
          sampleValues: { amount: '₦10,000' }
        });

      expect(okRes.status).toBe(200);
      expect(okRes.body.preview.renderedBody).toBe('Your deposit of ₦10,000 is complete.');

      const missingRes = await request(app)
        .post('/api/v1/admin/notification-templates/preview')
        .set('Authorization', `Bearer ${token}`)
        .send({
          code: 'DEPOSIT_CONFIRMED',
          title: 'Deposit Confirmed',
          bodyTemplate: 'Your deposit of {{amount}} is complete.',
          variables: ['amount'],
          sampleValues: {}
        });

      expect(missingRes.status).toBe(400);
      expect(missingRes.body.missingVariables).toEqual(['amount']);
    });
  });
});
