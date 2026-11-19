import crypto from 'node:crypto';
import { jest } from '@jest/globals';

const mockPrisma = {
  user: { findMany: jest.fn(), deleteMany: jest.fn(), updateMany: jest.fn(async () => ({ count: 0 })) },
  match: { findMany: jest.fn(), deleteMany: jest.fn() },
  ledgerTransaction: { findMany: jest.fn(), deleteMany: jest.fn(), count: jest.fn(async () => 0) },
  ledgerAccount: { findMany: jest.fn(), deleteMany: jest.fn() },
  ledgerEntry: { deleteMany: jest.fn(), groupBy: jest.fn(async () => []) },
  financialReconciliationRun: { create: jest.fn(), update: jest.fn() },
  $transaction: jest.fn()
};

jest.unstable_mockModule('../../utils/db.js', () => ({
  default: mockPrisma
}));

jest.unstable_mockModule('../../utils/redis.js', () => ({
  default: { del: jest.fn(), keys: jest.fn(async () => []) },
  isRedisReady: jest.fn(() => false)
}));

jest.unstable_mockModule('../../modules/rbac/service.js', () => ({
  requirePermission: jest.fn(() => (_req, _res, next) => next())
}));

jest.unstable_mockModule('../../modules/audit/service.js', () => ({
  recordAdminAction: jest.fn(async () => ({ id: 'aud_1' }))
}));

jest.unstable_mockModule('../../jobs/financialReconciliation.js', () => ({
  runFinancialReconciliation: jest.fn(async () => ({
    id: 'rec_sim_1',
    status: 'PASSED',
    discrepancies: []
  }))
}));

const {
  SIM_EMAIL_DOMAIN,
  simEmail,
  simUsername,
  simLabel,
  isSimEmail,
  assertSafeSimulationEnvironment,
  createPaystackMockSignature
} = await import('../simGuard.js');

const { isSimulationMockPaymentEnabled } = await import('../../modules/payment/PaymentGateway.js');
const { PaystackGateway } = await import('../../modules/payment/PaystackGateway.js');
const { FlutterwaveGateway } = await import('../../modules/payment/FlutterwaveGateway.js');
const { resetSimulationFixtures } = await import('../identityManager.js');
const { SimulationRunner } = await import('../SimulationRunner.js');
const { simulationRouter } = await import('../simulationController.js');

function createSafeEnv() {
  return {
    NODE_ENV: 'development',
    SIMULATION_ENABLED: 'true',
    SIMULATION_MOCK_PAYMENTS: 'true',
    DATABASE_URL: 'postgresql://postgres:local@127.0.0.1:5432/draughtbet_sim',
    PAYSTACK_SECRET_KEY: 'sk_test_local_sim',
    FLUTTERWAVE_SECRET_KEY: 'FLWSECK_TEST-local-sim'
  };
}

function makeFakeJwt(userId) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ userId })).toString('base64url');
  return `${header}.${payload}.fakesig`;
}

describe('Draught Bet Simulation Isolation & Orchestrator', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(process.env, originalEnv, createSafeEnv());
  });

  afterAll(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in originalEnv)) delete process.env[k];
    }
    Object.assign(process.env, originalEnv);
  });

  describe('simGuard safety boundaries', () => {
    test('formats deterministic synthetic emails and usernames under @draughtbet.sim', () => {
      expect(simEmail(1)).toBe(`sim.user01${SIM_EMAIL_DOMAIN}`);
      expect(simUsername(20)).toBe('sim_user_20');
      expect(simLabel(5)).toBe('User 05');
      expect(isSimEmail('sim.user03@draughtbet.sim')).toBe(true);
      expect(isSimEmail('player1@draughtbet.test')).toBe(false);
    });

    test('fails closed unless NODE_ENV=development and SIMULATION_ENABLED=true', () => {
      expect(() => assertSafeSimulationEnvironment()).not.toThrow();

      process.env.NODE_ENV = 'production';
      expect(() => assertSafeSimulationEnvironment()).toThrow(/NODE_ENV must be "development"/);

      process.env.NODE_ENV = 'development';
      process.env.SIMULATION_ENABLED = 'false';
      expect(() => assertSafeSimulationEnvironment()).toThrow(/SIMULATION_ENABLED=true/);
    });

    test('blocks Render, unflagged Neon, missing mock-payments on Neon, and live payment keys', () => {
      process.env.DATABASE_URL = 'postgresql://user:pass@ep-cool.us-east-2.aws.neon.tech/neondb';
      expect(() => assertSafeSimulationEnvironment()).toThrow(/SIMULATION_ALLOW_NEON=true/);

      process.env.SIMULATION_ALLOW_NEON = 'true';
      process.env.SIMULATION_MOCK_PAYMENTS = 'false';
      expect(() => assertSafeSimulationEnvironment()).toThrow(/SIMULATION_MOCK_PAYMENTS=true/);

      process.env.SIMULATION_MOCK_PAYMENTS = 'true';
      expect(() => assertSafeSimulationEnvironment()).not.toThrow();

      process.env.DATABASE_URL = 'postgresql://user:pass@dpg-prod.render.com/db';
      expect(() => assertSafeSimulationEnvironment()).toThrow(/blocked production host/);

      process.env.DATABASE_URL = 'postgresql://postgres:local@127.0.0.1:5432/draughtbet_sim';
      process.env.PAYSTACK_SECRET_KEY = 'sk_live_abc123';
      expect(() => assertSafeSimulationEnvironment()).toThrow(/live PAYSTACK_SECRET_KEY/);

      process.env.PAYSTACK_SECRET_KEY = 'sk_test_safe';
      process.env.FLUTTERWAVE_SECRET_KEY = 'FLWSECK-live-key';
      expect(() => assertSafeSimulationEnvironment()).toThrow(/live FLUTTERWAVE_SECRET_KEY/);
    });

    test('createPaystackMockSignature computes valid HMAC-SHA512 hex digest', () => {
      const body = '{"event":"charge.success"}';
      const expected = crypto.createHmac('sha512', 'sk_test_local_sim').update(body).digest('hex');
      expect(createPaystackMockSignature(body)).toBe(expected);
    });
  });

  describe('Offline mock payment gateways', () => {
    test('isSimulationMockPaymentEnabled is strictly gated to dev + mock flag + non-live keys', () => {
      expect(isSimulationMockPaymentEnabled()).toBe(true);

      process.env.NODE_ENV = 'production';
      expect(isSimulationMockPaymentEnabled()).toBe(false);

      process.env.NODE_ENV = 'development';
      process.env.SIMULATION_MOCK_PAYMENTS = 'false';
      expect(isSimulationMockPaymentEnabled()).toBe(false);
    });

    test('PaystackGateway and FlutterwaveGateway return synthetic mock results offline', async () => {
      const ps = new PaystackGateway();
      const flw = new FlutterwaveGateway();

      const psInit = await ps.initiatePayment(10000n, 'usr_1', 'sim.user01@draughtbet.sim', 'ref-ps-1');
      expect(psInit.reference).toBe('ref-ps-1');
      expect(psInit.authorizationUrl).toContain('/mock-checkout/paystack');

      const psBank = await ps.resolveBankAccount({ bankCode: '058', accountNumber: '0123456789' });
      expect(psBank.verified).toBe(true);
      expect(psBank.accountName).toBe('SIMULATED ACCOUNT 6789');

      const flwInit = await flw.initiatePayment(10000n, 'usr_1', 'sim.user01@draughtbet.sim', 'ref-flw-1');
      expect(flwInit.reference).toBe('ref-flw-1');
      expect(flwInit.authorizationUrl).toContain('/mock-checkout/flutterwave');
    });
  });

  describe('resetSimulationFixtures scoping', () => {
    test('refuses unscoped reset without runId and queries strictly runId-tagged users', async () => {
      await expect(resetSimulationFixtures()).rejects.toThrow(/requires a valid explicit runId/);

      mockPrisma.user.findMany.mockResolvedValueOnce([]);
      const summary = await resetSimulationFixtures({ runId: 'rabc1234' });
      expect(mockPrisma.user.findMany).toHaveBeenCalledWith({
        where: {
          AND: [
            { email: { startsWith: 'sim+rabc1234.' } },
            { email: { endsWith: '@draughtbet.sim' } }
          ]
        },
        select: { id: true, email: true }
      });
      expect(summary).toEqual({
        runId: 'rabc1234',
        removedUsers: 0,
        removedMatches: 0,
        removedTransactions: 0
      });
    });
  });

  describe('SimulationRunner lifecycle & scenario execution', () => {
    test('runs auth, wallet, and compliance scenarios across synthetic users with telemetry and pause/resume', async () => {
      const mockFetch = jest.fn(async (url, init) => {
        const path = new URL(url).pathname;
        let jsonBody = {};
        if (path === '/api/v1/auth/geo-locate') {
          jsonBody = { allowed: true, countryCode: 'NG', binding: 'geo_binding_token_12345' };
        } else if (path === '/api/v1/auth/register') {
          const parsed = JSON.parse(init.body);
          const uid = `uid_${parsed.username}`;
          jsonBody = {
            accessToken: makeFakeJwt(uid),
            refreshToken: `ref_${parsed.username}`
          };
          return { status: 201, text: async () => JSON.stringify(jsonBody) };
        } else if (path === '/api/v1/auth/refresh') {
          const parsed = JSON.parse(init.body);
          jsonBody = {
            accessToken: makeFakeJwt(parsed.userId),
            refreshToken: `${parsed.refreshToken}_rotated`
          };
        } else if (path === '/api/v1/wallet/balance') {
          jsonBody = { wallet: { availableMinorUnits: '100000' } };
        } else if (path === '/api/v1/wallet/bank-accounts') {
          jsonBody = { bankAccounts: [{ id: 'bank_1' }] };
        } else if (path === '/api/v1/wallet/withdrawal-request') {
          return { status: 201, text: async () => JSON.stringify({ withdrawalRequest: { id: 'wd_1' } }) };
        } else if (path === '/api/v1/verification/status') {
          jsonBody = { kycStatus: 'VERIFIED' };
        } else if (path === '/api/v1/notifications') {
          jsonBody = { notifications: [] };
        }
        return { status: 200, text: async () => JSON.stringify(jsonBody) };
      });

      const runner = new SimulationRunner({
        fetchImpl: mockFetch,
        baseOrigin: 'http://127.0.0.1:3005'
      });

      const report = await runner.start(
        {
          userCount: 4,
          concurrency: 2,
          durationMs: 6000,
          actionIntervalMs: 50,
          scenarios: ['auth', 'wallet', 'compliance']
        },
        { waitForCompletion: true }
      );

      expect(report.status).toBe('COMPLETED');
      expect(report.metrics.onlineUsers).toBe(4);
      expect(report.metrics.unexpectedStatuses).toBe(0);
      expect(report.metrics.totalRequests).toBeGreaterThanOrEqual(20);
      expect(report.roster).toHaveLength(4);
      expect(report.roster.every((u) => u.completedWorkflows === 3)).toBe(true);
    });

    test('pause and resume transitions work deterministically when IDLE/PAUSED', () => {
      const runner = new SimulationRunner();
      expect(runner.pause().status).toBe('IDLE');
      runner.status = 'RUNNING';
      expect(runner.pause().status).toBe('PAUSED');
      expect(runner.resume().status).toBe('RUNNING');
    });
  });

  describe('simulationRouter dev gate middleware', () => {
    test('returns 404 when SIMULATION_ENABLED is false', async () => {
      process.env.SIMULATION_ENABLED = 'false';
      const statusLayer = simulationRouter.stack.find((l) => l.route?.path === '/status');
      const gateMiddleware = statusLayer.route.stack[0].handle;

      const req = { ip: '127.0.0.1', get: () => 'jest', user: { id: 'admin_1' } };
      const res = {
        statusCode: 200,
        body: null,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(payload) {
          this.body = payload;
          return this;
        }
      };
      const next = jest.fn();
      gateMiddleware(req, res, next);
      expect(res.statusCode).toBe(404);
      expect(next).not.toHaveBeenCalled();
    });
  });
});
