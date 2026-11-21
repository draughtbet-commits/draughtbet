import { jest } from '@jest/globals';
import {
  ConfigService,
  ConfigValidationError,
  DraftNotFoundError,
  ImmutableVersionError,
  ChecksumIntegrityError,
  ConfigConflictError,
  MakerCheckerViolationError
} from '../service.js';
import { DEFAULT_CONFIG_PAYLOAD, CONFIG_DOMAINS } from '../schema.js';
import { generateChecksum } from '../canonicalJson.js';

describe('ConfigService (Unit)', () => {
  let mockDb;

  beforeEach(() => {
    mockDb = {
      $queryRaw: jest.fn(),
      $transaction: jest.fn(async (cb) => cb(mockDb)),
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
        findUnique: jest.fn(),
        upsert: jest.fn()
      },
      adminRoleAssignment: {
        findFirst: jest.fn()
      },
      user: {
        findFirst: jest.fn()
      },
      adminAuditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit-1' })
      }
    };
  });

  describe('allocateNextVersion', () => {
    it('allocates the next version atomically using PostgreSQL sequence', async () => {
      mockDb.$queryRaw.mockResolvedValueOnce([{ next_version: 7 }]);
      const version = await ConfigService.allocateNextVersion(mockDb);
      expect(version).toBe(7);
      expect(mockDb.$queryRaw).toHaveBeenCalled();
    });

    it('falls back gracefully if sequence query throws', async () => {
      mockDb.$queryRaw.mockRejectedValueOnce(new Error('Sequence error'));
      mockDb.platformConfigVersion.findFirst.mockResolvedValueOnce({ version: 4 });

      const version = await ConfigService.allocateNextVersion(mockDb);
      expect(version).toBe(5);
    });
  });

  describe('ensureInitialConfig & getActiveConfig', () => {
    it('seeds the initial active configuration version and syncs PlatformSettings if none exists', async () => {
      mockDb.platformConfigVersion.findFirst.mockResolvedValueOnce(null);
      mockDb.adminRoleAssignment.findFirst.mockResolvedValueOnce({ userId: 'super-admin-1' });

      const seededVersion = {
        id: 'v1-id',
        version: 1,
        status: 'ACTIVE',
        payload: DEFAULT_CONFIG_PAYLOAD,
        checksum: generateChecksum(DEFAULT_CONFIG_PAYLOAD),
        authorId: 'super-admin-1'
      };
      mockDb.platformConfigVersion.upsert.mockResolvedValueOnce(seededVersion);

      const result = await ConfigService.ensureInitialConfig({ dbp: mockDb });

      expect(result).toEqual(seededVersion);
      expect(mockDb.platformConfigVersion.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { version: 1 },
          create: expect.objectContaining({
            version: 1,
            status: 'ACTIVE',
            authorId: 'super-admin-1'
          })
        })
      );
      expect(mockDb.platformSettings.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'singleton' },
          create: expect.objectContaining({
            commissionPercent: 10,
            timeControlSeconds: 60
          })
        })
      );
    });

    it('returns existing active version without duplicate creation', async () => {
      const activeVersion = {
        id: 'v2-id',
        version: 2,
        status: 'ACTIVE',
        payload: DEFAULT_CONFIG_PAYLOAD,
        checksum: generateChecksum(DEFAULT_CONFIG_PAYLOAD)
      };
      mockDb.platformConfigVersion.findFirst.mockResolvedValueOnce(activeVersion);

      const result = await ConfigService.getActiveConfig({ dbp: mockDb });

      expect(result).toEqual(activeVersion);
      expect(mockDb.platformConfigVersion.upsert).not.toHaveBeenCalled();
    });

    it('throws ChecksumIntegrityError if active configuration payload does not match checksum', async () => {
      const tamperedVersion = {
        id: 'v1-tampered',
        version: 1,
        status: 'ACTIVE',
        payload: { ...DEFAULT_CONFIG_PAYLOAD, platform: { identity: 'Hacked Draughts' } },
        checksum: '0000000000000000000000000000000000000000000000000000000000000000'
      };
      mockDb.platformConfigVersion.findFirst.mockResolvedValueOnce(tamperedVersion);

      await expect(ConfigService.getActiveConfig({ dbp: mockDb })).rejects.toThrow(
        ChecksumIntegrityError
      );
    });
  });

  describe('createDraft', () => {
    it('creates a draft and records detected modified domains and restricted status', async () => {
      mockDb.platformConfigVersion.findFirst
        .mockResolvedValueOnce({
          version: 1,
          status: 'ACTIVE',
          payload: DEFAULT_CONFIG_PAYLOAD,
          checksum: generateChecksum(DEFAULT_CONFIG_PAYLOAD)
        });
      mockDb.$queryRaw.mockResolvedValueOnce([{ next_version: 2 }]);

      const modifiedPayload = structuredClone(DEFAULT_CONFIG_PAYLOAD);
      modifiedPayload.financial.commissionPercent = 12; // Restricted change in FINANCIAL domain

      const createdDraft = {
        id: 'draft-uuid-1',
        version: 2,
        status: 'DRAFT',
        isRestricted: true,
        modifiedDomains: [CONFIG_DOMAINS.FINANCIAL],
        changeReason: 'Adjust rake commission to 12%',
        authorId: 'admin-1',
        payload: modifiedPayload,
        checksum: generateChecksum(modifiedPayload)
      };
      mockDb.platformConfigVersion.create.mockResolvedValueOnce(createdDraft);

      const result = await ConfigService.createDraft({
        authorId: 'admin-1',
        changeReason: 'Adjust rake commission to 12%',
        payload: modifiedPayload,
        dbp: mockDb
      });

      expect(result.isRestricted).toBe(true);
      expect(result.modifiedDomains).toContain(CONFIG_DOMAINS.FINANCIAL);
      expect(result.version).toBe(2);
      expect(mockDb.platformConfigVersion.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          version: 2,
          status: 'DRAFT',
          isRestricted: true,
          modifiedDomains: [CONFIG_DOMAINS.FINANCIAL],
          authorId: 'admin-1',
          changeReason: 'Adjust rake commission to 12%'
        }),
        include: { author: { select: { id: true, email: true, username: true } } }
      });
      expect(mockDb.adminAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'config.draft.created',
          adminId: 'admin-1',
          targetType: 'PlatformConfigVersion',
          targetId: 'draft-uuid-1',
          outcome: 'SUCCESS'
        })
      });
    });

    it('creates a non-restricted draft when only operational parameters change', async () => {
      mockDb.platformConfigVersion.findFirst
        .mockResolvedValueOnce({
          version: 1,
          status: 'ACTIVE',
          payload: DEFAULT_CONFIG_PAYLOAD,
          checksum: generateChecksum(DEFAULT_CONFIG_PAYLOAD)
        });
      mockDb.$queryRaw.mockResolvedValueOnce([{ next_version: 2 }]);

      const modifiedPayload = structuredClone(DEFAULT_CONFIG_PAYLOAD);
      modifiedPayload.platform.supportEmail = 'support2@draughtbet.com';
      modifiedPayload.game.timeControlSeconds = 45;

      mockDb.platformConfigVersion.create.mockResolvedValueOnce({
        id: 'draft-uuid-2',
        version: 2,
        status: 'DRAFT',
        isRestricted: false,
        modifiedDomains: [CONFIG_DOMAINS.PLATFORM, CONFIG_DOMAINS.GAME],
        payload: modifiedPayload
      });

      const result = await ConfigService.createDraft({
        authorId: 'admin-1',
        changeReason: 'Update support email and turn timer',
        payload: modifiedPayload,
        dbp: mockDb
      });

      expect(result.isRestricted).toBe(false);
      expect(result.modifiedDomains).toEqual([CONFIG_DOMAINS.PLATFORM, CONFIG_DOMAINS.GAME]);
    });

    it('rejects draft creation with an empty or too short change reason', async () => {
      await expect(
        ConfigService.createDraft({
          authorId: 'admin-1',
          changeReason: 'fix',
          dbp: mockDb
        })
      ).rejects.toThrow(ConfigValidationError);
    });
  });

  describe('updateDraft', () => {
    it('updates an existing draft in-place', async () => {
      const existingDraft = {
        id: 'draft-1',
        version: 2,
        status: 'DRAFT',
        payload: DEFAULT_CONFIG_PAYLOAD,
        changeReason: 'Initial reason'
      };
      mockDb.platformConfigVersion.findUnique.mockResolvedValueOnce(existingDraft);
      mockDb.platformConfigVersion.findFirst.mockResolvedValueOnce({
        version: 1,
        status: 'ACTIVE',
        payload: DEFAULT_CONFIG_PAYLOAD
      });

      const updatedPayload = structuredClone(DEFAULT_CONFIG_PAYLOAD);
      updatedPayload.game.timeControlSeconds = 30;

      mockDb.platformConfigVersion.update.mockResolvedValueOnce({
        ...existingDraft,
        payload: updatedPayload,
        modifiedDomains: [CONFIG_DOMAINS.GAME],
        checksum: generateChecksum(updatedPayload)
      });

      const result = await ConfigService.updateDraft({
        draftId: 'draft-1',
        authorId: 'admin-1',
        payload: updatedPayload,
        changeReason: 'Adjusted time control to 30s',
        dbp: mockDb
      });

      expect(result.payload.game.timeControlSeconds).toBe(30);
      expect(mockDb.adminAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'config.draft.updated',
          adminId: 'admin-1',
          targetId: 'draft-1'
        })
      });
    });

    it('enforces immutability: rejects updates to PENDING_APPROVAL, ACTIVE, or SUPERSEDED versions', async () => {
      // 1. Submitted draft (PENDING_APPROVAL) cannot be modified
      const submittedVersion = {
        id: 'pending-v1',
        version: 2,
        status: 'PENDING_APPROVAL',
        payload: DEFAULT_CONFIG_PAYLOAD
      };
      mockDb.platformConfigVersion.findUnique.mockResolvedValueOnce(submittedVersion);

      await expect(
        ConfigService.updateDraft({
          draftId: 'pending-v1',
          authorId: 'admin-1',
          payload: DEFAULT_CONFIG_PAYLOAD,
          dbp: mockDb
        })
      ).rejects.toThrow(ImmutableVersionError);

      // 2. Active version cannot be modified
      const activeVersion = {
        id: 'active-v1',
        version: 1,
        status: 'ACTIVE',
        payload: DEFAULT_CONFIG_PAYLOAD
      };
      mockDb.platformConfigVersion.findUnique.mockResolvedValueOnce(activeVersion);

      await expect(
        ConfigService.updateDraft({
          draftId: 'active-v1',
          authorId: 'admin-1',
          payload: DEFAULT_CONFIG_PAYLOAD,
          dbp: mockDb
        })
      ).rejects.toThrow(ImmutableVersionError);
    });

    it('throws DraftNotFoundError for non-existent drafts', async () => {
      mockDb.platformConfigVersion.findUnique.mockResolvedValueOnce(null);

      await expect(
        ConfigService.updateDraft({
          draftId: 'missing-id',
          authorId: 'admin-1',
          payload: DEFAULT_CONFIG_PAYLOAD,
          dbp: mockDb
        })
      ).rejects.toThrow(DraftNotFoundError);
    });
  });

  describe('deleteDraft', () => {
    it('deletes an un-submitted draft and audits the deletion', async () => {
      const draft = {
        id: 'draft-to-delete',
        version: 3,
        status: 'DRAFT'
      };
      mockDb.platformConfigVersion.findUnique.mockResolvedValueOnce(draft);
      mockDb.platformConfigVersion.delete.mockResolvedValueOnce(draft);

      const result = await ConfigService.deleteDraft({
        draftId: 'draft-to-delete',
        actorId: 'admin-1',
        dbp: mockDb
      });

      expect(result.deleted).toBe(true);
      expect(mockDb.platformConfigVersion.delete).toHaveBeenCalledWith({
        where: { id: 'draft-to-delete', status: 'DRAFT' }
      });
      expect(mockDb.adminAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'config.draft.deleted',
          adminId: 'admin-1',
          targetId: 'draft-to-delete'
        })
      });
    });

    it('enforces immutability: rejects deletion of non-draft versions', async () => {
      const activeVersion = {
        id: 'active-to-delete',
        version: 1,
        status: 'ACTIVE'
      };
      mockDb.platformConfigVersion.findUnique.mockResolvedValueOnce(activeVersion);

      await expect(
        ConfigService.deleteDraft({
          draftId: 'active-to-delete',
          actorId: 'admin-1',
          dbp: mockDb
        })
      ).rejects.toThrow(ImmutableVersionError);
      expect(mockDb.platformConfigVersion.delete).not.toHaveBeenCalled();
    });
  });

  describe('validateDraftPayload (Dry Run)', () => {
    it('returns valid: true with checksum, restriction flag, and modifiedDomains', async () => {
      const payload = structuredClone(DEFAULT_CONFIG_PAYLOAD);
      payload.financial.commissionPercent = 15;

      const result = await ConfigService.validateDraftPayload({
        payload,
        dbp: mockDb
      });

      expect(result.valid).toBe(true);
      expect(result.isRestricted).toBe(true);
      expect(result.modifiedDomains).toContain(CONFIG_DOMAINS.FINANCIAL);
      expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns valid: false with issues array on invalid candidate', async () => {
      const invalid = structuredClone(DEFAULT_CONFIG_PAYLOAD);
      invalid.financial.commissionPercent = 50; // max is 25

      const result = await ConfigService.validateDraftPayload({
        payload: invalid,
        dbp: mockDb
      });

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('submitDraft', () => {
    it('submits a valid DRAFT for approval and updates status to PENDING_APPROVAL', async () => {
      const draft = {
        id: 'draft-1',
        version: 2,
        status: 'DRAFT',
        payload: DEFAULT_CONFIG_PAYLOAD,
        checksum: generateChecksum(DEFAULT_CONFIG_PAYLOAD),
        authorId: 'admin-1',
        isRestricted: false,
        modifiedDomains: []
      };
      mockDb.platformConfigVersion.findUnique.mockResolvedValueOnce(draft);
      mockDb.platformConfigVersion.update.mockResolvedValueOnce({
        ...draft,
        status: 'PENDING_APPROVAL'
      });

      const submitted = await ConfigService.submitDraft({
        draftId: 'draft-1',
        authorId: 'admin-1',
        dbp: mockDb
      });

      expect(submitted.status).toBe('PENDING_APPROVAL');
      expect(mockDb.platformConfigVersion.update).toHaveBeenCalledWith({
        where: { id: 'draft-1', status: 'DRAFT', checksum: draft.checksum },
        data: { status: 'PENDING_APPROVAL' },
        include: expect.any(Object)
      });
      expect(mockDb.adminAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'config.draft.submitted',
          targetId: 'draft-1'
        })
      });
    });

    it('rejects submitting a draft that is not in DRAFT status', async () => {
      mockDb.platformConfigVersion.findUnique.mockResolvedValueOnce({
        id: 'draft-1',
        version: 2,
        status: 'PENDING_APPROVAL',
        payload: DEFAULT_CONFIG_PAYLOAD,
        checksum: generateChecksum(DEFAULT_CONFIG_PAYLOAD)
      });

      await expect(
        ConfigService.submitDraft({
          draftId: 'draft-1',
          authorId: 'admin-1',
          dbp: mockDb
        })
      ).rejects.toThrow(ConfigConflictError);
    });
  });

  describe('approveVersion (Maker-Checker)', () => {
    const targetPayload = DEFAULT_CONFIG_PAYLOAD;
    const targetChecksum = generateChecksum(targetPayload);

    it('approves a submitted version with independent reviewer and matching checksum', async () => {
      const version = {
        id: 'ver-2',
        version: 2,
        status: 'PENDING_APPROVAL',
        authorId: 'maker-author',
        payload: targetPayload,
        checksum: targetChecksum
      };
      mockDb.platformConfigVersion.findUnique.mockResolvedValueOnce(version);
      mockDb.configApproval.create.mockResolvedValueOnce({
        id: 'appr-1',
        versionId: 'ver-2',
        reviewerId: 'checker-reviewer',
        status: 'APPROVED',
        checksum: targetChecksum,
        reviewNote: 'Approved for release'
      });
      mockDb.platformConfigVersion.update.mockResolvedValueOnce({
        ...version,
        status: 'APPROVED'
      });

      const result = await ConfigService.approveVersion({
        versionId: 'ver-2',
        reviewerId: 'checker-reviewer',
        reviewNote: 'Approved for release',
        clientChecksum: targetChecksum,
        dbp: mockDb
      });

      expect(result.version.status).toBe('APPROVED');
      expect(mockDb.configApproval.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          versionId: 'ver-2',
          reviewerId: 'checker-reviewer',
          status: 'APPROVED',
          checksum: targetChecksum
        }),
        include: expect.any(Object)
      });
    });

    it('strictly prohibits author from approving their own proposal', async () => {
      mockDb.platformConfigVersion.findUnique.mockResolvedValueOnce({
        id: 'ver-2',
        version: 2,
        status: 'PENDING_APPROVAL',
        authorId: 'maker-author',
        payload: targetPayload,
        checksum: targetChecksum
      });

      await expect(
        ConfigService.approveVersion({
          versionId: 'ver-2',
          reviewerId: 'maker-author', // Same user!
          clientChecksum: targetChecksum,
          dbp: mockDb
        })
      ).rejects.toThrow(MakerCheckerViolationError);
    });

    it('rejects approval when client checksum does not match server canonical checksum', async () => {
      mockDb.platformConfigVersion.findUnique.mockResolvedValueOnce({
        id: 'ver-2',
        version: 2,
        status: 'PENDING_APPROVAL',
        authorId: 'maker-author',
        payload: targetPayload,
        checksum: targetChecksum
      });

      await expect(
        ConfigService.approveVersion({
          versionId: 'ver-2',
          reviewerId: 'checker-reviewer',
          clientChecksum: '0000000000000000000000000000000000000000000000000000000000000000',
          dbp: mockDb
        })
      ).rejects.toThrow(ChecksumIntegrityError);
    });

    it('rejects approval if version is not in PENDING_APPROVAL status', async () => {
      mockDb.platformConfigVersion.findUnique.mockResolvedValueOnce({
        id: 'ver-2',
        version: 2,
        status: 'DRAFT',
        authorId: 'maker-author',
        payload: targetPayload,
        checksum: targetChecksum
      });

      await expect(
        ConfigService.approveVersion({
          versionId: 'ver-2',
          reviewerId: 'checker-reviewer',
          dbp: mockDb
        })
      ).rejects.toThrow(ConfigConflictError);
    });
  });

  describe('rejectVersion (Maker-Checker)', () => {
    const targetPayload = DEFAULT_CONFIG_PAYLOAD;
    const targetChecksum = generateChecksum(targetPayload);

    it('rejects proposal with mandatory reason and author/reviewer separation', async () => {
      const version = {
        id: 'ver-2',
        version: 2,
        status: 'PENDING_APPROVAL',
        authorId: 'maker-author',
        payload: targetPayload,
        checksum: targetChecksum
      };
      mockDb.platformConfigVersion.findUnique.mockResolvedValueOnce(version);
      mockDb.configApproval.create.mockResolvedValueOnce({
        id: 'appr-rej',
        versionId: 'ver-2',
        reviewerId: 'checker-reviewer',
        status: 'REJECTED',
        checksum: targetChecksum,
        reviewNote: 'Stake ranges are too wide'
      });
      mockDb.platformConfigVersion.update.mockResolvedValueOnce({
        ...version,
        status: 'REJECTED'
      });

      const result = await ConfigService.rejectVersion({
        versionId: 'ver-2',
        reviewerId: 'checker-reviewer',
        reason: 'Stake ranges are too wide',
        dbp: mockDb
      });

      expect(result.version.status).toBe('REJECTED');
      expect(mockDb.configApproval.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          status: 'REJECTED',
          reviewNote: 'Stake ranges are too wide'
        }),
        include: expect.any(Object)
      });
    });

    it('prohibits author from rejecting their own proposal', async () => {
      mockDb.platformConfigVersion.findUnique.mockResolvedValueOnce({
        id: 'ver-2',
        version: 2,
        status: 'PENDING_APPROVAL',
        authorId: 'maker-author',
        payload: targetPayload,
        checksum: targetChecksum
      });

      await expect(
        ConfigService.rejectVersion({
          versionId: 'ver-2',
          reviewerId: 'maker-author',
          reason: 'I changed my mind',
          dbp: mockDb
        })
      ).rejects.toThrow(MakerCheckerViolationError);
    });
  });

  describe('activateVersion (Atomic Activation)', () => {
    const targetPayload = DEFAULT_CONFIG_PAYLOAD;
    const targetChecksum = generateChecksum(targetPayload);

    it('atomically activates an APPROVED version, supersedes old, and creates OutboxEvent', async () => {
      const targetVersion = {
        id: 'ver-2',
        version: 2,
        status: 'APPROVED',
        payload: targetPayload,
        checksum: targetChecksum,
        isRestricted: false,
        modifiedDomains: [],
        approvals: [
          {
            id: 'appr-1',
            status: 'APPROVED',
            checksum: targetChecksum,
            reviewerId: 'checker-1'
          }
        ]
      };
      mockDb.platformConfigVersion.findUnique.mockResolvedValueOnce(targetVersion);
      mockDb.platformConfigVersion.update.mockResolvedValueOnce({
        ...targetVersion,
        status: 'ACTIVE',
        activatedAt: new Date()
      });

      const activated = await ConfigService.activateVersion({
        versionId: 'ver-2',
        activatorId: 'super-admin-1',
        dbp: mockDb
      });

      expect(activated.status).toBe('ACTIVE');
      expect(mockDb.platformConfigVersion.updateMany).toHaveBeenCalledWith({
        where: { status: 'ACTIVE' },
        data: expect.objectContaining({ status: 'SUPERSEDED' })
      });
      expect(mockDb.outboxEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          aggregateType: 'PlatformConfigVersion',
          aggregateId: 'ver-2',
          eventType: 'platform.config.activated',
          dedupeKey: 'config:activated:2'
        })
      });
      expect(mockDb.platformSettings.upsert).toHaveBeenCalledWith({
        where: { id: 'singleton' },
        create: expect.any(Object),
        update: expect.any(Object)
      });
    });

    it('fails activation if version is not APPROVED', async () => {
      mockDb.platformConfigVersion.findUnique.mockResolvedValueOnce({
        id: 'ver-2',
        version: 2,
        status: 'DRAFT',
        payload: targetPayload,
        checksum: targetChecksum,
        approvals: []
      });

      await expect(
        ConfigService.activateVersion({
          versionId: 'ver-2',
          activatorId: 'super-admin-1',
          dbp: mockDb
        })
      ).rejects.toThrow(ConfigConflictError);
    });

    it('fails activation if approval checksum does not match payload checksum', async () => {
      mockDb.platformConfigVersion.findUnique.mockResolvedValueOnce({
        id: 'ver-2',
        version: 2,
        status: 'APPROVED',
        payload: targetPayload,
        checksum: targetChecksum,
        approvals: [
          {
            id: 'appr-stale',
            status: 'APPROVED',
            checksum: 'stale-mismatched-checksum-hash',
            reviewerId: 'checker-1'
          }
        ]
      });

      await expect(
        ConfigService.activateVersion({
          versionId: 'ver-2',
          activatorId: 'super-admin-1',
          dbp: mockDb
        })
      ).rejects.toThrow(ChecksumIntegrityError);
    });
  });

  describe('rollbackVersion (Non-destructive)', () => {
    it('creates a new version N+1 staging historical payload with rolledBackFrom pointer', async () => {
      const historical = {
        id: 'ver-1',
        version: 1,
        status: 'SUPERSEDED',
        payload: DEFAULT_CONFIG_PAYLOAD,
        checksum: generateChecksum(DEFAULT_CONFIG_PAYLOAD)
      };
      mockDb.platformConfigVersion.findUnique.mockResolvedValueOnce(historical);
      mockDb.$queryRaw.mockResolvedValueOnce([{ next_version: 5 }]);
      mockDb.platformConfigVersion.create.mockResolvedValueOnce({
        id: 'ver-5',
        version: 5,
        status: 'DRAFT',
        rolledBackFrom: 1,
        payload: DEFAULT_CONFIG_PAYLOAD,
        checksum: historical.checksum
      });

      const rollback = await ConfigService.rollbackVersion({
        targetVersionNumber: 1,
        actorId: 'admin-1',
        reason: 'Emergency rollback to version 1',
        dbp: mockDb
      });

      expect(rollback.version).toBe(5);
      expect(rollback.rolledBackFrom).toBe(1);
      expect(mockDb.platformConfigVersion.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          version: 5,
          status: 'DRAFT',
          rolledBackFrom: 1,
          authorId: 'admin-1'
        }),
        include: expect.any(Object)
      });
    });
  });

  describe('ensureInitialConfig legacy preservation', () => {
    it('preserves valid custom PlatformSettings values into initial config', async () => {
      mockDb.platformConfigVersion.findFirst.mockResolvedValueOnce(null);
      mockDb.adminRoleAssignment.findFirst.mockResolvedValueOnce({ userId: 'admin-1' });
      mockDb.platformSettings.findUnique.mockResolvedValueOnce({
        commissionPercent: 12,
        timeControlSeconds: 90,
        limitRaiseCoolingHours: 48,
        amateurStakeMinP: 1000n,
        amateurStakeMaxP: 20000n,
        masterStakeMinP: 15000n,
        masterStakeMaxP: 40000n,
        proStakeMinP: 35000n,
        proStakeMaxP: 250000n,
        amateurCalloutMaxP: 15000n,
        masterCalloutMaxP: 30000n,
        proCalloutMaxP: 200000n
      });

      mockDb.platformConfigVersion.upsert.mockImplementationOnce(({ create }) => Promise.resolve(create));

      const result = await ConfigService.ensureInitialConfig({ dbp: mockDb });

      expect(result.payload.financial.commissionPercent).toBe(12);
      expect(result.payload.game.timeControlSeconds).toBe(90);
      expect(result.payload.saferPlay.limitRaiseCoolingHours).toBe(48);
      expect(result.payload.tiers.AMATEUR.minStake).toBe('1000');
    });

    it('recovers safely from concurrent startup race conditions', async () => {
      mockDb.platformConfigVersion.findFirst
        .mockResolvedValueOnce(null) // first check: not found
        .mockResolvedValueOnce({ version: 1, status: 'ACTIVE' }); // concurrent find: found

      mockDb.adminRoleAssignment.findFirst.mockResolvedValueOnce({ userId: 'admin-1' });
      mockDb.platformSettings.findUnique.mockResolvedValueOnce(null);
      mockDb.platformConfigVersion.upsert.mockRejectedValueOnce(new Error('Unique constraint violation: platform_config_single_active_idx'));

      const result = await ConfigService.ensureInitialConfig({ dbp: mockDb });

      expect(result).toEqual({ version: 1, status: 'ACTIVE' });
    });
  });
});
