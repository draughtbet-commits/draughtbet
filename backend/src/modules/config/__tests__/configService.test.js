import { jest } from '@jest/globals';
import {
  ConfigService,
  ConfigValidationError,
  DraftNotFoundError,
  ImmutableVersionError,
  ChecksumIntegrityError
} from '../service.js';
import { DEFAULT_CONFIG_PAYLOAD, CONFIG_DOMAINS } from '../schema.js';
import { generateChecksum } from '../canonicalJson.js';

describe('ConfigService (Unit)', () => {
  let mockDb;

  beforeEach(() => {
    mockDb = {
      $queryRaw: jest.fn(),
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
        id: 'v1-existing',
        version: 1,
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
      const corruptVersion = {
        id: 'v1-corrupt',
        version: 1,
        status: 'ACTIVE',
        payload: DEFAULT_CONFIG_PAYLOAD,
        checksum: '0000000000000000000000000000000000000000000000000000000000000000'
      };
      mockDb.platformConfigVersion.findFirst.mockResolvedValueOnce(corruptVersion);

      await expect(ConfigService.getActiveConfig({ dbp: mockDb })).rejects.toThrow(
        ChecksumIntegrityError
      );
    });
  });

  describe('createDraft', () => {
    it('creates a draft and records detected modified domains and restricted status', async () => {
      mockDb.$queryRaw.mockResolvedValueOnce([{ next_version: 2 }]);
      mockDb.platformConfigVersion.findFirst.mockResolvedValueOnce({
        id: 'active-v1',
        version: 1,
        status: 'ACTIVE',
        payload: DEFAULT_CONFIG_PAYLOAD
      });

      const proposedPayload = structuredClone(DEFAULT_CONFIG_PAYLOAD);
      proposedPayload.financial.commissionPercent = 15; // Restricted domain modification

      const createdDraft = {
        id: 'draft-uuid-1',
        version: 2,
        status: 'DRAFT',
        payload: proposedPayload,
        checksum: generateChecksum(proposedPayload),
        changeReason: 'Adjusted commission to 15 percent',
        isRestricted: true,
        modifiedDomains: [CONFIG_DOMAINS.FINANCIAL],
        authorId: 'admin-1'
      };
      mockDb.platformConfigVersion.create.mockResolvedValueOnce(createdDraft);

      const result = await ConfigService.createDraft({
        authorId: 'admin-1',
        changeReason: 'Adjusted commission to 15 percent',
        payload: proposedPayload,
        dbp: mockDb
      });

      expect(result.version).toBe(2);
      expect(result.isRestricted).toBe(true);
      expect(result.modifiedDomains).toContain(CONFIG_DOMAINS.FINANCIAL);
      expect(mockDb.adminAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'config.draft.created',
          adminId: 'admin-1',
          targetId: 'draft-uuid-1'
        })
      });
    });

    it('creates a non-restricted draft when only operational parameters change', async () => {
      mockDb.$queryRaw.mockResolvedValueOnce([{ next_version: 2 }]);
      mockDb.platformConfigVersion.findFirst.mockResolvedValueOnce({
        id: 'active-v1',
        version: 1,
        status: 'ACTIVE',
        payload: DEFAULT_CONFIG_PAYLOAD
      });

      const proposedPayload = structuredClone(DEFAULT_CONFIG_PAYLOAD);
      proposedPayload.game.timeControlSeconds = 90; // Operational change

      const createdDraft = {
        id: 'draft-uuid-2',
        version: 2,
        status: 'DRAFT',
        payload: proposedPayload,
        checksum: generateChecksum(proposedPayload),
        changeReason: 'Increase turn time control to 90s',
        isRestricted: false,
        modifiedDomains: [CONFIG_DOMAINS.GAME],
        authorId: 'admin-1'
      };
      mockDb.platformConfigVersion.create.mockResolvedValueOnce(createdDraft);

      const result = await ConfigService.createDraft({
        authorId: 'admin-1',
        changeReason: 'Increase turn time control to 90s',
        payload: proposedPayload,
        dbp: mockDb
      });

      expect(result.isRestricted).toBe(false);
      expect(result.modifiedDomains).toContain(CONFIG_DOMAINS.GAME);
    });

    it('rejects draft creation with an empty or too short change reason', async () => {
      await expect(
        ConfigService.createDraft({
          authorId: 'admin-1',
          changeReason: 'bad',
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
        checksum: generateChecksum(DEFAULT_CONFIG_PAYLOAD),
        changeReason: 'Initial reason'
      };
      mockDb.platformConfigVersion.findUnique.mockResolvedValueOnce(existingDraft);
      mockDb.platformConfigVersion.findFirst.mockResolvedValueOnce({
        id: 'active-v1',
        version: 1,
        status: 'ACTIVE',
        payload: DEFAULT_CONFIG_PAYLOAD
      });

      const updatedDraft = {
        ...existingDraft,
        changeReason: 'Updated detailed reason'
      };
      mockDb.platformConfigVersion.update.mockResolvedValueOnce(updatedDraft);

      const result = await ConfigService.updateDraft({
        draftId: 'draft-1',
        authorId: 'admin-1',
        changeReason: 'Updated detailed reason',
        dbp: mockDb
      });

      expect(result.changeReason).toBe('Updated detailed reason');
      expect(mockDb.platformConfigVersion.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'draft-1' }
        })
      );
    });

    it('enforces immutability: rejects updates to PENDING_APPROVAL, ACTIVE, or SUPERSEDED versions', async () => {
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
        where: { id: 'draft-to-delete' }
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
});
