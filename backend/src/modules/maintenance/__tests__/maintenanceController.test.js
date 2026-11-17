import { jest, describe, it, expect, beforeEach } from '@jest/globals';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.REDIS_URL = '';
process.env.JWT_SECRET = 'unittest-admin-secret-maintenance';

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
    create: jest.fn().mockResolvedValue({ id: 'audit-log-maint-1' }),
    findMany: jest.fn(),
    count: jest.fn()
  },
  maintenanceState: {
    findUnique: jest.fn(),
    upsert: jest.fn(),
    update: jest.fn()
  },
  outboxEvent: {
    create: jest.fn().mockResolvedValue({ id: 'outbox-maint-1' })
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

describe('Maintenance Admin API Endpoints (Integration)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.user.findUnique.mockResolvedValue(adminUser);
  });

  describe('GET /api/v1/admin/maintenance', () => {
    it('allows any admin role with MAINTENANCE_READ to inspect current maintenance status', async () => {
      mockPrisma.maintenanceState.findUnique.mockResolvedValueOnce({
        id: 'singleton',
        active: true,
        scope: 'GAMEPLAY_ONLY',
        headline: 'Scheduled Game Engine Maintenance',
        message: 'Game rooms are paused for 30 minutes.',
        allowedIps: [],
        allowedRoles: ['SUPER_ADMIN'],
        startsAt: null,
        endsAt: null
      });

      const token = await asRole('SUPPORT');
      const res = await request(app)
        .get('/api/v1/admin/maintenance')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.maintenance.active).toBe(true);
      expect(res.body.maintenance.effectivelyActive).toBe(true);
      expect(res.body.maintenance.scope).toBe('GAMEPLAY_ONLY');
      expect(res.body.maintenance.exemptPrefixes).toContain('/api/v1/auth');
      expect(res.body.maintenance.exemptPrefixes).toContain('/api/v1/admin');
    });
  });

  describe('POST /api/v1/admin/maintenance/enable, /disable & /emergency-reset', () => {
    it('allows SUPER_ADMIN (MAINTENANCE_MANAGE) to enable, disable, and emergency-reset maintenance mode', async () => {
      mockPrisma.maintenanceState.findUnique.mockResolvedValueOnce(null);
      mockPrisma.maintenanceState.upsert.mockImplementation(async ({ create, update }) => ({
        id: 'singleton',
        ...(create || {}),
        ...(update || {}),
        updatedAt: new Date().toISOString()
      }));

      const token = await asRole('SUPER_ADMIN');
      const enableRes = await request(app)
        .post('/api/v1/admin/maintenance/enable')
        .set('Authorization', `Bearer ${token}`)
        .send({
          scope: 'FINANCIAL_ONLY',
          headline: 'Payment Provider Maintenance',
          message: 'Deposits and withdrawals are temporarily paused during gateway maintenance.',
          reason: 'Paystack scheduled maintenance window'
        });

      expect(enableRes.status).toBe(200);
      expect(enableRes.body.maintenance.active).toBe(true);
      expect(enableRes.body.maintenance.scope).toBe('FINANCIAL_ONLY');

      // Disable
      mockPrisma.maintenanceState.findUnique.mockResolvedValueOnce({
        id: 'singleton',
        active: true,
        scope: 'FINANCIAL_ONLY'
      });
      const disableRes = await request(app)
        .post('/api/v1/admin/maintenance/disable')
        .set('Authorization', `Bearer ${token}`)
        .send({
          reason: 'Paystack maintenance window completed'
        });

      expect(disableRes.status).toBe(200);
      expect(disableRes.body.maintenance.active).toBe(false);

      // Emergency reset
      const emergencyRes = await request(app)
        .post('/api/v1/admin/maintenance/emergency-reset')
        .set('Authorization', `Bearer ${token}`)
        .send({
          reason: 'Emergency recovery verification'
        });

      expect(emergencyRes.status).toBe(200);
      expect(emergencyRes.body.recovered).toBe(true);
      expect(emergencyRes.body.maintenance.active).toBe(false);
    });

    it('rejects attempts to remove SUPER_ADMIN from allowedRoles with 403', async () => {
      const token = await asRole('SUPER_ADMIN');
      const res = await request(app)
        .patch('/api/v1/admin/maintenance')
        .set('Authorization', `Bearer ${token}`)
        .send({
          active: true,
          allowedRoles: ['FINANCE'],
          reason: 'Attempt to lock out SUPER_ADMIN'
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/SUPER_ADMIN must always be included/i);
    });

    it('denies non-SUPER_ADMIN roles from enabling or disabling maintenance with 403', async () => {
      for (const role of ['FINANCE', 'RISK_COMPLIANCE', 'SUPPORT', 'GAME_OPERATIONS', 'READ_ONLY_AUDITOR']) {
        const token = await asRole(role);
        const res = await request(app)
          .post('/api/v1/admin/maintenance/enable')
          .set('Authorization', `Bearer ${token}`)
          .send({
            scope: 'FULL_PLATFORM',
            reason: 'Unauthorized maintenance enable attempt'
          });

        expect(res.status).toBe(403);
      }
    });
  });
});
