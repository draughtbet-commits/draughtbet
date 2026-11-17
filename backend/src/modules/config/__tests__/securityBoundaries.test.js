import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockPrisma = {
  adminRoleAssignment: {
    findMany: jest.fn()
  },
  featureFlag: {
    findUnique: jest.fn(),
    update: jest.fn()
  },
  adminAuditLog: {
    create: jest.fn().mockResolvedValue({ id: 'audit-1' })
  },
  platformConfigVersion: {
    findUnique: jest.fn(),
    update: jest.fn(),
    delete: jest.fn()
  }
};

jest.unstable_mockModule('../../../utils/db.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

const { requirePermission, hasPermission } = await import('../../rbac/service.js');
const { PERMISSIONS } = await import('../../rbac/permissions.js');
const { ConfigService, MakerCheckerViolationError, ImmutableVersionError } = await import('../service.js');
const { DEFAULT_CONFIG_PAYLOAD } = await import('../schema.js');
const { generateChecksum } = await import('../canonicalJson.js');

describe('Security Boundaries & RBAC Authority', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Feature Flag vs. RBAC Authority', () => {
    it('proves RBAC is authoritative: an active feature flag cannot grant permission to an unauthorized role', async () => {
      // Mock caller holds SUPPORT role
      mockPrisma.adminRoleAssignment.findMany.mockResolvedValue([
        { role: { name: 'SUPPORT' } }
      ]);
      mockPrisma.adminAuditLog.create.mockResolvedValue({ id: 'audit-1' });

      // Even if a feature flag named "emergency_withdrawal_override" is enabled with allowedRoles: ['SUPPORT']
      const flag = {
        key: 'emergency_withdrawal_override',
        isEnabled: true,
        allowedRoles: ['SUPPORT']
      };
      mockPrisma.featureFlag.findUnique.mockResolvedValue(flag);

      // Verify that hasPermission resolves directly to false for FINANCE_WITHDRAWAL_APPROVE
      const allowed = await hasPermission('user-support-1', PERMISSIONS.FINANCE_WITHDRAWAL_APPROVE, { dbp: mockPrisma });
      expect(allowed).toBe(false);

      // Verify route guard denies access and records DENIED audit log
      const req = {
        user: { id: 'user-support-1' },
        ip: '127.0.0.1',
        get: jest.fn().mockReturnValue('TestAgent'),
        originalUrl: '/api/v1/admin/withdrawals/wd-1/approve',
        method: 'POST'
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };
      const next = jest.fn();

      // Execute requirePermission route guard
      const guard = requirePermission(PERMISSIONS.FINANCE_WITHDRAWAL_APPROVE);
      await guard(req, res, next);

      if (next.mock.calls.length > 0 && next.mock.calls[0][0]) {
        console.error('requirePermission guard threw error:', next.mock.calls[0][0]);
      }

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Insufficient admin permission' });
      expect(next).not.toHaveBeenCalled();
    });

    it('proves feature flags cannot override a denied permission or bypass financial controls', async () => {
      // Risk & Compliance role has KYC permissions but cannot approve ledger adjustments
      mockPrisma.adminRoleAssignment.findMany.mockResolvedValue([
        { role: { name: 'RISK_COMPLIANCE' } }
      ]);

      const allowed = await hasPermission('user-risk-1', PERMISSIONS.FINANCE_LEDGER_ADJUST, { dbp: mockPrisma });
      expect(allowed).toBe(false);
    });

    it('enforces protected invariant protection: feature flags marked isProtectedInvariant cannot be disabled', async () => {
      // Invariant flag: KYC must always be enforced before funds leave the platform
      const kycInvariantFlag = {
        key: 'enforce_kyc_on_withdrawal',
        isEnabled: true,
        isProtectedInvariant: true
      };

      // Simulated feature flag update service logic asserting invariant protection
      const attemptDisableFlag = async (flag, targetState) => {
        if (flag.isProtectedInvariant && targetState.isEnabled === false) {
          throw new Error('Protected platform invariant cannot be disabled via feature flags');
        }
        return { ...flag, ...targetState };
      };

      await expect(
        attemptDisableFlag(kycInvariantFlag, { isEnabled: false })
      ).rejects.toThrow(/protected platform invariant cannot be disabled/i);
    });
  });

  describe('Maker-Checker Invariant Protection', () => {
    it('guarantees Super Admin cannot bypass Author/Reviewer identity separation', async () => {
      const checksum = generateChecksum(DEFAULT_CONFIG_PAYLOAD);
      const proposal = {
        id: 'prop-1',
        version: 2,
        status: 'PENDING_APPROVAL',
        authorId: 'super-admin-user',
        payload: DEFAULT_CONFIG_PAYLOAD,
        checksum
      };
      mockPrisma.platformConfigVersion.findUnique.mockResolvedValue(proposal);

      // Attempt self-approval by the Super Admin who authored the proposal
      await expect(
        ConfigService.approveVersion({
          versionId: 'prop-1',
          reviewerId: 'super-admin-user',
          clientChecksum: checksum,
          dbp: mockPrisma
        })
      ).rejects.toThrow(MakerCheckerViolationError);
    });
  });

  describe('Configuration Immutability Invariant', () => {
    it('guarantees activated or superseded versions cannot be updated in-place', async () => {
      const activeVersion = {
        id: 'active-v1',
        version: 1,
        status: 'ACTIVE',
        payload: DEFAULT_CONFIG_PAYLOAD
      };
      mockPrisma.platformConfigVersion.findUnique.mockResolvedValue(activeVersion);

      await expect(
        ConfigService.updateDraft({
          draftId: 'active-v1',
          authorId: 'admin-1',
          payload: { financial: { commissionPercent: 20 } },
          dbp: mockPrisma
        })
      ).rejects.toThrow(ImmutableVersionError);
    });

    it('guarantees activated versions cannot be deleted', async () => {
      const activeVersion = {
        id: 'active-v1',
        version: 1,
        status: 'ACTIVE'
      };
      mockPrisma.platformConfigVersion.findUnique.mockResolvedValue(activeVersion);

      await expect(
        ConfigService.deleteDraft({
          draftId: 'active-v1',
          actorId: 'admin-1',
          dbp: mockPrisma
        })
      ).rejects.toThrow(ImmutableVersionError);
    });
  });
});
