import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import {
  MaintenanceService,
  MaintenanceValidationError,
  MaintenanceLockoutProtectionError
} from '../service.js';
import { DEFAULT_MAINTENANCE_STATE } from '../schema.js';
import { runEmergencyMaintenanceReset } from '../../../../scripts/emergencyMaintenanceReset.js';

describe('MaintenanceService (Unit)', () => {
  let mockDb;

  beforeEach(() => {
    mockDb = {
      $transaction: jest.fn(async (cb) => cb(mockDb)),
      maintenanceState: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn()
      },
      outboxEvent: {
        create: jest.fn().mockResolvedValue({ id: 'outbox-maint-1' })
      },
      adminAuditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit-maint-1' }),
        findMany: jest.fn(),
        count: jest.fn()
      }
    };
  });

  describe('computeEffectiveState & Scheduled Maintenance Windows', () => {
    it('evaluates INACTIVE, SCHEDULED, ACTIVE, and EXPIRED states accurately', () => {
      const now = new Date('2026-11-17T12:00:00Z');

      // 1. Inactive
      const inactive = MaintenanceService.computeEffectiveState(
        { ...DEFAULT_MAINTENANCE_STATE, active: false },
        now
      );
      expect(inactive.effectiveStatus).toBe('INACTIVE');
      expect(inactive.effectivelyActive).toBe(false);

      // 2. Scheduled in future
      const scheduled = MaintenanceService.computeEffectiveState(
        {
          ...DEFAULT_MAINTENANCE_STATE,
          active: true,
          startsAt: '2026-11-17T14:00:00Z',
          endsAt: '2026-11-17T16:00:00Z'
        },
        now
      );
      expect(scheduled.effectiveStatus).toBe('SCHEDULED');
      expect(scheduled.effectivelyActive).toBe(false);

      // 3. Currently within active window
      const active = MaintenanceService.computeEffectiveState(
        {
          ...DEFAULT_MAINTENANCE_STATE,
          active: true,
          startsAt: '2026-11-17T11:00:00Z',
          endsAt: '2026-11-17T13:00:00Z'
        },
        now
      );
      expect(active.effectiveStatus).toBe('ACTIVE');
      expect(active.effectivelyActive).toBe(true);

      // 4. Past endsAt -> automatically EXPIRED
      const expired = MaintenanceService.computeEffectiveState(
        {
          ...DEFAULT_MAINTENANCE_STATE,
          active: true,
          startsAt: '2026-11-17T08:00:00Z',
          endsAt: '2026-11-17T10:00:00Z'
        },
        now
      );
      expect(expired.effectiveStatus).toBe('EXPIRED');
      expect(expired.effectivelyActive).toBe(false);
    });
  });

  describe('enableMaintenance, disableMaintenance & Lockout Protections', () => {
    it('enables maintenance mode with custom scope and message, writes OutboxEvent and AdminAuditLog', async () => {
      mockDb.maintenanceState.findUnique.mockResolvedValueOnce(null);
      mockDb.maintenanceState.upsert.mockImplementationOnce(async ({ create }) => ({
        ...create,
        updatedAt: new Date('2026-11-17T12:00:00Z')
      }));

      const state = await MaintenanceService.enableMaintenance({
        scope: 'GAMEPLAY_ONLY',
        headline: 'Gameplay Server Upgrade',
        message: 'Active matches are paused while we upgrade game servers. Wallet access remains open.',
        allowedIps: ['127.0.0.1'],
        allowedRoles: ['SUPER_ADMIN', 'GAME_OPERATIONS'],
        reason: 'Upgrade Redis game cluster nodes',
        actorId: 'admin-super-1',
        now: new Date('2026-11-17T12:00:00Z'),
        dbp: mockDb
      });

      expect(state.active).toBe(true);
      expect(state.effectivelyActive).toBe(true);
      expect(state.scope).toBe('GAMEPLAY_ONLY');
      expect(state.allowedRoles).toContain('SUPER_ADMIN');
      expect(mockDb.outboxEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            aggregateType: 'MaintenanceState',
            eventType: 'platform.maintenance.updated'
          })
        })
      );
      expect(mockDb.adminAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'maintenance.enabled',
            adminId: 'admin-super-1',
            targetType: 'MaintenanceState'
          })
        })
      );
    });

    it('rejects any configuration that removes SUPER_ADMIN from allowedRoles (Accidental Lockout Protection)', async () => {
      await expect(
        MaintenanceService.updateMaintenanceState({
          active: true,
          allowedRoles: ['SUPPORT'], // Missing SUPER_ADMIN
          reason: 'Attempt to exclude SUPER_ADMIN',
          actorId: 'admin-super-1',
          dbp: mockDb
        })
      ).rejects.toThrow(MaintenanceLockoutProtectionError);
    });

    it('rejects invalid scheduled windows where endsAt <= startsAt or duration > 7 days', async () => {
      mockDb.maintenanceState.findUnique.mockResolvedValue(null);

      await expect(
        MaintenanceService.enableMaintenance({
          startsAt: '2026-11-18T12:00:00Z',
          endsAt: '2026-11-18T10:00:00Z', // before startsAt
          reason: 'Invalid window ordering test',
          actorId: 'admin-super-1',
          dbp: mockDb
        })
      ).rejects.toThrow(MaintenanceValidationError);

      await expect(
        MaintenanceService.enableMaintenance({
          startsAt: '2026-11-18T12:00:00Z',
          endsAt: '2026-12-18T12:00:00Z', // 30 days > 7 days max
          reason: 'Excessive maintenance window duration test',
          actorId: 'admin-super-1',
          dbp: mockDb
        })
      ).rejects.toThrow(MaintenanceValidationError);
    });

    it('rejects HTML/script injection in user-facing headline or message', async () => {
      mockDb.maintenanceState.findUnique.mockResolvedValue(null);

      await expect(
        MaintenanceService.updateMaintenanceState({
          headline: '<script>alert(1)</script> Maintenance',
          reason: 'XSS headline attempt',
          actorId: 'admin-super-1',
          dbp: mockDb
        })
      ).rejects.toThrow(MaintenanceValidationError);
    });
  });

  describe('evaluateRequestAccess & Scope Enforcement', () => {
    const activeFullState = {
      ...DEFAULT_MAINTENANCE_STATE,
      active: true,
      scope: 'FULL_PLATFORM',
      allowedIps: ['10.20.30.40'],
      allowedRoles: ['SUPER_ADMIN', 'GAME_OPERATIONS']
    };

    it('NEVER blocks /api/v1/auth, /api/v1/admin, /webhooks, /health, or /ready even during FULL_PLATFORM maintenance', async () => {
      for (const exemptPath of [
        '/health',
        '/ready',
        '/webhooks/paystack',
        '/api/v1/auth/login',
        '/api/v1/auth/refresh',
        '/api/v1/admin/me',
        '/api/v1/admin/maintenance',
        '/api/v1/maintenance/status'
      ]) {
        const res = await MaintenanceService.evaluateRequestAccess({
          path: exemptPath,
          state: activeFullState,
          dbp: mockDb
        });
        expect(res.allowed).toBe(true);
        expect(res.reason).toBe('EXEMPT_PROTECTED_SURFACE');
      }
    });

    it('enforces scope boundaries accurately (MATCHMAKING_ONLY, GAMEPLAY_ONLY, FINANCIAL_ONLY, FULL_PLATFORM)', async () => {
      // 1. MATCHMAKING_ONLY blocks /api/v1/matchmaking and /api/v1/callouts, but allows /api/v1/matches and /api/v1/wallet
      const mmState = { ...activeFullState, scope: 'MATCHMAKING_ONLY' };
      const mmJoin = await MaintenanceService.evaluateRequestAccess({
        path: '/api/v1/matchmaking/join',
        state: mmState
      });
      expect(mmJoin.allowed).toBe(false);
      expect(mmJoin.status).toBe(503);

      const activeMatchState = await MaintenanceService.evaluateRequestAccess({
        path: '/api/v1/matches/m-123/state',
        state: mmState
      });
      expect(activeMatchState.allowed).toBe(true);
      expect(activeMatchState.reason).toBe('OUTSIDE_MAINTENANCE_SCOPE');

      // 2. FINANCIAL_ONLY blocks /api/v1/wallet, but allows /api/v1/matches and /api/v1/matchmaking
      const finState = { ...activeFullState, scope: 'FINANCIAL_ONLY' };
      const walletReq = await MaintenanceService.evaluateRequestAccess({
        path: '/api/v1/wallet/deposit-intent',
        state: finState
      });
      expect(walletReq.allowed).toBe(false);
      expect(walletReq.status).toBe(503);

      const mmDuringFin = await MaintenanceService.evaluateRequestAccess({
        path: '/api/v1/matchmaking/join',
        state: finState
      });
      expect(mmDuringFin.allowed).toBe(true);
    });

    it('preserves access for allowed admin roles and allowed IPs during active maintenance', async () => {
      const adminBypass = await MaintenanceService.evaluateRequestAccess({
        path: '/api/v1/matches/m-1',
        adminRoles: ['SUPER_ADMIN'],
        state: activeFullState
      });
      expect(adminBypass.allowed).toBe(true);
      expect(adminBypass.reason).toBe('ADMIN_ROLE_BYPASS');

      const ipBypass = await MaintenanceService.evaluateRequestAccess({
        path: '/api/v1/wallet/balance',
        ip: '10.20.30.40',
        state: activeFullState
      });
      expect(ipBypass.allowed).toBe(true);
      expect(ipBypass.reason).toBe('ALLOWED_IP_BYPASS');
    });
  });

  describe('Emergency Recovery Safeguards', () => {
    it('executes MaintenanceService.emergencyReset and clears active maintenance state', async () => {
      mockDb.maintenanceState.upsert.mockImplementationOnce(async ({ update }) => ({
        ...DEFAULT_MAINTENANCE_STATE,
        ...update,
        updatedAt: new Date()
      }));

      const res = await MaintenanceService.emergencyReset({
        reason: 'Emergency recovery after bad maintenance window',
        actorId: 'admin-super-1',
        dbp: mockDb
      });

      expect(res.active).toBe(false);
      expect(res.effectivelyActive).toBe(false);
      expect(mockDb.adminAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'maintenance.emergency_reset',
            adminId: 'admin-super-1'
          })
        })
      );
    });

    it('executes standalone runEmergencyMaintenanceReset CLI helper against MaintenanceState.active and Redis', async () => {
      mockDb.maintenanceState.findUnique.mockResolvedValueOnce({
        id: 'singleton',
        active: true,
        scope: 'FULL_PLATFORM'
      });
      mockDb.maintenanceState.update.mockImplementationOnce(async ({ data }) => ({
        id: 'singleton',
        ...data
      }));

      const mockRedisClient = {
        del: jest.fn().mockResolvedValue(1),
        publish: jest.fn().mockResolvedValue(1),
        disconnect: jest.fn()
      };

      const result = await runEmergencyMaintenanceReset({
        dbp: mockDb,
        redisUrl: 'redis://localhost:6379',
        redisFactory: () => mockRedisClient
      });

      expect(result.wasActive).toBe(true);
      expect(result.active).toBe(false);
      expect(result.redisPurged).toBe(true);
      expect(mockDb.maintenanceState.update).toHaveBeenCalledWith({
        where: { id: 'singleton' },
        data: {
          active: false,
          startsAt: null,
          endsAt: expect.any(Date)
        }
      });
      expect(mockRedisClient.del).toHaveBeenCalledWith('maintenance:state:v2');
      expect(mockRedisClient.publish).toHaveBeenCalledWith(
        'platform:maintenance:invalidated',
        expect.any(String)
      );
    });
  });
});
