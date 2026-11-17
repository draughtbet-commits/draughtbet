import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import {
  FeatureFlagService,
  FeatureFlagValidationError,
  FeatureFlagNotFoundError,
  FeatureFlagConflictError,
  ProtectedInvariantError
} from '../service.js';
import { computeRolloutBucket, isProtectedInvariantFlag } from '../schema.js';

describe('FeatureFlagService (Unit)', () => {
  let mockDb;

  beforeEach(() => {
    mockDb = {
      $transaction: jest.fn(async (cb) => cb(mockDb)),
      featureFlag: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn(),
        delete: jest.fn()
      },
      outboxEvent: {
        create: jest.fn().mockResolvedValue({ id: 'outbox-ff-1' })
      },
      adminAuditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit-ff-1' }),
        findMany: jest.fn(),
        count: jest.fn()
      }
    };
  });

  describe('computeRolloutBucket & Deterministic Rollout', () => {
    it('computes a deterministic integer bucket in [0, 99] for any (flagKey, subjectId) pair', () => {
      const b1 = computeRolloutBucket('enhanced_match_replay_viewer', 'user-abc-123');
      const b2 = computeRolloutBucket('enhanced_match_replay_viewer', 'user-abc-123');
      expect(b1).toBe(b2);
      expect(Number.isInteger(b1)).toBe(true);
      expect(b1).toBeGreaterThanOrEqual(0);
      expect(b1).toBeLessThan(100);
    });

    it('preserves monotonic rollout expansion (users in 20% cohort stay included at 50% and 80%)', async () => {
      const userIds = Array.from({ length: 100 }, (_, i) => `player-uuid-${i}`);

      const evaluateAtPercentage = async (pct) => {
        mockDb.featureFlag.findUnique.mockResolvedValue({
          id: 'ff-rollout',
          key: 'progressive_feature',
          name: 'Progressive Feature',
          enabled: true,
          rolloutPercentage: pct,
          allowedTiers: [],
          allowedRoles: [],
          isKillSwitch: false
        });

        const enabledUsers = new Set();
        for (const uid of userIds) {
          const res = await FeatureFlagService.evaluateFlag('progressive_feature', {
            userId: uid,
            userTier: 'AMATEUR',
            dbp: mockDb
          });
          if (res.enabled) enabledUsers.add(uid);
        }
        return enabledUsers;
      };

      const cohort0 = await evaluateAtPercentage(0);
      const cohort25 = await evaluateAtPercentage(25);
      const cohort60 = await evaluateAtPercentage(60);
      const cohort100 = await evaluateAtPercentage(100);

      expect(cohort0.size).toBe(0);
      expect(cohort100.size).toBe(100);
      expect(cohort25.size).toBeGreaterThan(0);
      expect(cohort60.size).toBeGreaterThanOrEqual(cohort25.size);

      // Every user enabled at 25% must remain enabled at 60%
      for (const uid of cohort25) {
        expect(cohort60.has(uid)).toBe(true);
      }
    });

    it('requires subjectId when evaluating a partial rollout (1..99%)', async () => {
      mockDb.featureFlag.findUnique.mockResolvedValue({
        id: 'ff-partial',
        key: 'partial_flag',
        enabled: true,
        rolloutPercentage: 50,
        allowedTiers: [],
        allowedRoles: []
      });

      const res = await FeatureFlagService.evaluateFlag('partial_flag', {
        userId: null,
        dbp: mockDb
      });
      expect(res.enabled).toBe(false);
      expect(res.reason).toBe('SUBJECT_ID_REQUIRED_FOR_PARTIAL_ROLLOUT');
    });
  });

  describe('Player Tier Targeting', () => {
    it('allows only players in allowedTiers when tier targeting is configured', async () => {
      mockDb.featureFlag.findUnique.mockResolvedValue({
        id: 'ff-callout',
        key: 'callout_challenges_enabled',
        enabled: true,
        rolloutPercentage: 100,
        allowedTiers: ['MASTER', 'PRO'],
        allowedRoles: [],
        isKillSwitch: true
      });

      const amateurEval = await FeatureFlagService.evaluateFlag('callout_challenges_enabled', {
        userId: 'u-amateur',
        userTier: 'AMATEUR',
        dbp: mockDb
      });
      expect(amateurEval.enabled).toBe(false);
      expect(amateurEval.reason).toBe('TIER_NOT_ELIGIBLE');

      const masterEval = await FeatureFlagService.evaluateFlag('callout_challenges_enabled', {
        userId: 'u-master',
        userTier: 'MASTER',
        dbp: mockDb
      });
      expect(masterEval.enabled).toBe(true);
      expect(masterEval.reason).toBe('FULL_ROLLOUT');
    });
  });

  describe('createFlag & updateFlag', () => {
    it('creates a valid feature flag, writes transactional outbox event, and records audit log', async () => {
      mockDb.featureFlag.findUnique.mockResolvedValueOnce(null);
      mockDb.featureFlag.create.mockImplementation(async ({ data }) => ({
        id: 'ff-new-1',
        ...data,
        createdAt: new Date(),
        updatedAt: new Date()
      }));

      const created = await FeatureFlagService.createFlag({
        key: 'new_tournament_banner',
        name: 'New Tournament Banner',
        description: 'Shows seasonal tournament banner',
        enabled: true,
        rolloutPercentage: 40,
        allowedTiers: ['MASTER', 'PRO'],
        allowedRoles: ['SUPER_ADMIN', 'GAME_OPERATIONS'],
        isKillSwitch: false,
        changeReason: 'Launch seasonal tournament preview',
        actorId: 'admin-super-1',
        dbp: mockDb
      });

      expect(created.key).toBe('new_tournament_banner');
      expect(created.rolloutPercentage).toBe(40);
      expect(mockDb.outboxEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            aggregateType: 'FeatureFlag',
            eventType: 'platform.feature_flag.updated'
          })
        })
      );
      expect(mockDb.adminAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            adminId: 'admin-super-1',
            action: 'feature_flag.created',
            targetType: 'FeatureFlag'
          })
        })
      );
    });

    it('rejects duplicate feature flag keys with 409 FeatureFlagConflictError', async () => {
      mockDb.featureFlag.findUnique.mockResolvedValueOnce({
        id: 'existing-1',
        key: 'dup_flag'
      });

      await expect(
        FeatureFlagService.createFlag({
          key: 'dup_flag',
          name: 'Duplicate Flag',
          changeReason: 'Attempt duplicate key',
          actorId: 'admin-1',
          dbp: mockDb
        })
      ).rejects.toThrow(FeatureFlagConflictError);
    });

    it('rejects metadata attempting to grant permissions or bypass RBAC/KYC/ledger', async () => {
      await expect(
        FeatureFlagService.createFlag({
          key: 'illegal_rbac_flag',
          name: 'Illegal RBAC Override',
          metadata: { grantsPermissions: ['withdrawals.process'] },
          changeReason: 'Attempt privilege escalation via metadata',
          actorId: 'admin-1',
          dbp: mockDb
        })
      ).rejects.toThrow(FeatureFlagValidationError);
    });
  });

  describe('Kill Switches & Protected Invariants', () => {
    it('trips and resets a kill switch with mandatory reason and high-priority audit log', async () => {
      mockDb.featureFlag.findUnique.mockResolvedValueOnce({
        id: 'ff-ks-1',
        key: 'live_matchmaking_queue',
        name: 'Live Matchmaking Queue',
        enabled: true,
        rolloutPercentage: 100,
        allowedTiers: ['AMATEUR', 'MASTER', 'PRO'],
        allowedRoles: ['SUPER_ADMIN', 'GAME_OPERATIONS'],
        isKillSwitch: true
      });

      mockDb.featureFlag.update.mockImplementation(async ({ data }) => ({
        id: 'ff-ks-1',
        key: 'live_matchmaking_queue',
        name: 'Live Matchmaking Queue',
        rolloutPercentage: 100,
        isKillSwitch: true,
        ...data,
        updatedAt: new Date()
      }));

      const tripped = await FeatureFlagService.triggerKillSwitch({
        key: 'live_matchmaking_queue',
        enabled: false,
        reason: 'Emergency halt during Redis latency spike',
        actorId: 'game-ops-admin',
        dbp: mockDb
      });

      expect(tripped.enabled).toBe(false);
      expect(mockDb.adminAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'feature_flag.kill_switch.triggered',
            adminId: 'game-ops-admin',
            metadata: expect.objectContaining({
              key: 'live_matchmaking_queue',
              previousEnabled: true,
              enabled: false,
              isKillSwitch: true,
              reason: 'Emergency halt during Redis latency spike'
            })
          })
        })
      );
    });

    it('rejects triggerKillSwitch on a flag that is not designated as a kill switch', async () => {
      mockDb.featureFlag.findUnique.mockResolvedValueOnce({
        id: 'ff-normal',
        key: 'ui_banner',
        enabled: true,
        isKillSwitch: false
      });

      await expect(
        FeatureFlagService.triggerKillSwitch({
          key: 'ui_banner',
          enabled: false,
          reason: 'Trying to use kill switch endpoint on non-killswitch flag',
          actorId: 'game-ops-1',
          dbp: mockDb
        })
      ).rejects.toThrow(FeatureFlagConflictError);
    });

    it('forbids disabling, diluting, or deleting protected invariant flags', async () => {
      const invariantFlag = {
        id: 'ff-inv-1',
        key: 'enforce_kyc_on_withdrawal',
        name: 'Enforce KYC on Withdrawal',
        enabled: true,
        rolloutPercentage: 100,
        allowedTiers: [],
        allowedRoles: ['SUPER_ADMIN'],
        isKillSwitch: false,
        metadata: { isProtectedInvariant: true }
      };
      expect(isProtectedInvariantFlag(invariantFlag)).toBe(true);

      mockDb.featureFlag.findUnique.mockResolvedValue(invariantFlag);

      await expect(
        FeatureFlagService.toggleFlag({
          key: 'enforce_kyc_on_withdrawal',
          enabled: false,
          changeReason: 'Attempt to disable KYC',
          actorId: 'admin-1',
          dbp: mockDb
        })
      ).rejects.toThrow(ProtectedInvariantError);

      await expect(
        FeatureFlagService.deleteFlag({
          key: 'enforce_kyc_on_withdrawal',
          reason: 'Attempt to delete KYC invariant',
          actorId: 'admin-1',
          dbp: mockDb
        })
      ).rejects.toThrow(ProtectedInvariantError);
    });
  });

  describe('Admin Visibility Controls & History', () => {
    it('evaluates admin visibility by role while keeping grantsPermissions false', () => {
      const flag = {
        key: 'risk_analytics_panel',
        enabled: true,
        allowedRoles: ['RISK_COMPLIANCE']
      };

      const supportVis = FeatureFlagService.computeAdminVisibility(flag, ['SUPPORT']);
      expect(supportVis.visible).toBe(false);
      expect(supportVis.grantsPermissions).toBe(false);
      expect(supportVis.rbacAuthoritative).toBe(true);

      const riskVis = FeatureFlagService.computeAdminVisibility(flag, ['RISK_COMPLIANCE']);
      expect(riskVis.visible).toBe(true);
      expect(riskVis.grantsPermissions).toBe(false);

      const superVis = FeatureFlagService.computeAdminVisibility(flag, ['SUPER_ADMIN']);
      expect(superVis.visible).toBe(true);
      expect(superVis.grantsPermissions).toBe(false);
    });

    it('returns paginated feature flag history from AdminAuditLog', async () => {
      mockDb.featureFlag.findUnique.mockResolvedValueOnce({
        id: 'ff-hist-1',
        key: 'live_matchmaking_queue',
        name: 'Live Matchmaking Queue'
      });
      mockDb.adminAuditLog.findMany.mockResolvedValueOnce([
        { id: 'log-1', action: 'feature_flag.kill_switch.triggered', createdAt: new Date() }
      ]);
      mockDb.adminAuditLog.count.mockResolvedValueOnce(1);

      const res = await FeatureFlagService.getFlagHistory('live_matchmaking_queue', {
        page: 1,
        limit: 10,
        dbp: mockDb
      });

      expect(res.total).toBe(1);
      expect(res.history).toHaveLength(1);
      expect(res.flag.key).toBe('live_matchmaking_queue');
    });
  });
});
