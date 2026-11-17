import prisma from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { recordAdminAction } from '../audit/service.js';
import { canonicalizeJson, generateChecksum, verifyChecksum } from './canonicalJson.js';
import {
  PlatformConfigPayloadSchema,
  DEFAULT_CONFIG_PAYLOAD,
  detectModifiedDomains,
  isRestrictedDomains,
  isRestrictedChange
} from './schema.js';

export class ConfigValidationError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'ConfigValidationError';
    this.status = 400;
    this.issues = issues;
  }
}

export class DraftNotFoundError extends Error {
  constructor(message = 'Configuration draft not found') {
    super(message);
    this.name = 'DraftNotFoundError';
    this.status = 404;
  }
}

export class ImmutableVersionError extends Error {
  constructor(message = 'Submitted, activated, or superseded configuration versions cannot be modified or deleted') {
    super(message);
    this.name = 'ImmutableVersionError';
    this.status = 409;
  }
}

export class ChecksumIntegrityError extends Error {
  constructor(message = 'Configuration payload failed SHA-256 checksum integrity verification') {
    super(message);
    this.name = 'ChecksumIntegrityError';
    this.status = 409;
  }
}

export class ConfigService {
  /**
   * Concurrency-safe atomic version number allocation using PostgreSQL sequence.
   * Eliminates race conditions under simultaneous draft creation requests.
   */
  static async allocateNextVersion(dbp = prisma) {
    if (typeof dbp.$queryRaw === 'function') {
      try {
        const rows = await dbp.$queryRaw`SELECT nextval('platform_config_version_seq')::int AS next_version`;
        if (rows && rows[0]?.next_version) {
          return Number(rows[0].next_version);
        }
      } catch (err) {
        logger.warn({ err }, 'Could not read from platform_config_version_seq; using fallback query');
      }
    }

    // Fallback for mocked unit tests or environments without sequence access
    const highest = await dbp.platformConfigVersion.findFirst({
      orderBy: { version: 'desc' },
      select: { version: true }
    });
    return (highest?.version ?? 0) + 1;
  }

  /**
   * Idempotently seeds the initial ACTIVE Version 1 if no configuration versions exist.
   * Also ensures legacy PlatformSettings singleton reflects baseline values.
   */
  static async ensureInitialConfig({ systemUserId = null, dbp = prisma } = {}) {
    const existingActive = await dbp.platformConfigVersion.findFirst({
      where: { status: 'ACTIVE' },
      orderBy: { version: 'desc' }
    });

    if (existingActive) {
      return existingActive;
    }

    // Resolve an author for the initial version
    let authorId = systemUserId;
    if (!authorId) {
      const superAdminAssignment = await dbp.adminRoleAssignment.findFirst({
        where: { role: { name: 'SUPER_ADMIN' } },
        select: { userId: true }
      });
      authorId = superAdminAssignment?.userId;
    }

    if (!authorId) {
      const anyUser = await dbp.user.findFirst({ select: { id: true } });
      authorId = anyUser?.id;
    }

    if (!authorId) {
      logger.warn('No user exists to author the initial configuration version; skipping seed until user exists');
      return null;
    }

    const payload = DEFAULT_CONFIG_PAYLOAD;
    const checksum = generateChecksum(payload);

    const initialVersion = await dbp.platformConfigVersion.upsert({
      where: { version: 1 },
      create: {
        version: 1,
        status: 'ACTIVE',
        checksum,
        payload,
        changeReason: 'Initial platform configuration bootstrap',
        isRestricted: false,
        modifiedDomains: [],
        authorId,
        activatedById: authorId,
        activatedAt: new Date()
      },
      update: {}
    });

    // Synchronize legacy PlatformSettings singleton
    try {
      await dbp.platformSettings.upsert({
        where: { id: 'singleton' },
        create: {
          id: 'singleton',
          commissionPercent: payload.financial.commissionPercent,
          limitRaiseCoolingHours: payload.saferPlay.limitRaiseCoolingHours,
          timeControlSeconds: payload.game.timeControlSeconds,
          amateurStakeMinP: BigInt(payload.tiers.AMATEUR.minStake),
          amateurStakeMaxP: BigInt(payload.tiers.AMATEUR.maxStake),
          masterStakeMinP: BigInt(payload.tiers.MASTER.minStake),
          masterStakeMaxP: BigInt(payload.tiers.MASTER.maxStake),
          proStakeMinP: BigInt(payload.tiers.PRO.minStake),
          proStakeMaxP: BigInt(payload.tiers.PRO.maxStake),
          amateurCalloutMaxP: BigInt(payload.tiers.AMATEUR.maxCallout),
          masterCalloutMaxP: BigInt(payload.tiers.MASTER.maxCallout),
          proCalloutMaxP: BigInt(payload.tiers.PRO.maxCallout)
        },
        update: {
          commissionPercent: payload.financial.commissionPercent,
          limitRaiseCoolingHours: payload.saferPlay.limitRaiseCoolingHours,
          timeControlSeconds: payload.game.timeControlSeconds,
          amateurStakeMinP: BigInt(payload.tiers.AMATEUR.minStake),
          amateurStakeMaxP: BigInt(payload.tiers.AMATEUR.maxStake),
          masterStakeMinP: BigInt(payload.tiers.MASTER.minStake),
          masterStakeMaxP: BigInt(payload.tiers.MASTER.maxStake),
          proStakeMinP: BigInt(payload.tiers.PRO.minStake),
          proStakeMaxP: BigInt(payload.tiers.PRO.maxStake),
          amateurCalloutMaxP: BigInt(payload.tiers.AMATEUR.maxCallout),
          masterCalloutMaxP: BigInt(payload.tiers.MASTER.maxCallout),
          proCalloutMaxP: BigInt(payload.tiers.PRO.maxCallout)
        }
      });
    } catch (err) {
      logger.warn({ err }, 'Could not sync legacy PlatformSettings during initial config seed');
    }

    logger.info({ version: initialVersion.version, checksum }, 'Seeded initial platform configuration version');
    return initialVersion;
  }

  /**
   * Retrieves the currently active configuration version.
   * Performs SHA-256 integrity verification against the canonical payload.
   */
  static async getActiveConfig({ dbp = prisma } = {}) {
    let active = await dbp.platformConfigVersion.findFirst({
      where: { status: 'ACTIVE' },
      orderBy: { version: 'desc' }
    });

    if (!active) {
      active = await this.ensureInitialConfig({ dbp });
    }

    if (!active) {
      return {
        id: 'in-memory-fallback',
        version: 1,
        status: 'ACTIVE',
        checksum: generateChecksum(DEFAULT_CONFIG_PAYLOAD),
        payload: DEFAULT_CONFIG_PAYLOAD,
        changeReason: 'In-memory default configuration',
        isRestricted: false,
        modifiedDomains: [],
        createdAt: new Date()
      };
    }

    // Integrity check
    if (!verifyChecksum(active.payload, active.checksum)) {
      logger.error(
        { version: active.version, storedChecksum: active.checksum },
        'Active configuration failed SHA-256 integrity check'
      );
      throw new ChecksumIntegrityError(
        `Active configuration version ${active.version} failed integrity verification`
      );
    }

    return active;
  }

  /**
   * Retrieves paginated configuration version history.
   */
  static async getVersionHistory({
    page = 1,
    limit = 20,
    status = null,
    dbp = prisma
  } = {}) {
    const where = {};
    if (status) {
      where.status = status;
    }

    const skip = (Math.max(1, page) - 1) * Math.max(1, limit);
    const take = Math.min(100, Math.max(1, limit));

    const [rows, total] = await Promise.all([
      dbp.platformConfigVersion.findMany({
        where,
        orderBy: { version: 'desc' },
        skip,
        take,
        select: {
          id: true,
          version: true,
          status: true,
          checksum: true,
          changeReason: true,
          effectiveFrom: true,
          isRestricted: true,
          modifiedDomains: true,
          authorId: true,
          author: {
            select: { id: true, email: true, username: true }
          },
          activatedById: true,
          activatedBy: {
            select: { id: true, email: true, username: true }
          },
          activatedAt: true,
          supersededAt: true,
          rolledBackFrom: true,
          createdAt: true,
          updatedAt: true
        }
      }),
      dbp.platformConfigVersion.count({ where })
    ]);

    return {
      versions: rows,
      total,
      page,
      totalPages: Math.ceil(total / take)
    };
  }

  /**
   * Retrieves a single configuration version by business version number.
   */
  static async getVersionByNumber(versionNumber, { dbp = prisma } = {}) {
    const num = Number.parseInt(versionNumber, 10);
    if (Number.isNaN(num) || num <= 0) {
      throw new ConfigValidationError('Version must be a positive integer');
    }

    const version = await dbp.platformConfigVersion.findUnique({
      where: { version: num },
      include: {
        author: { select: { id: true, email: true, username: true } },
        activatedBy: { select: { id: true, email: true, username: true } },
        approvals: {
          include: {
            reviewer: { select: { id: true, email: true, username: true } }
          }
        }
      }
    });

    if (!version) {
      return null;
    }

    // Verify SHA-256 integrity
    if (!verifyChecksum(version.payload, version.checksum)) {
      throw new ChecksumIntegrityError(
        `Configuration version ${version.version} payload checksum mismatch`
      );
    }

    return version;
  }

  /**
   * Performs a dry-run validation of a candidate payload.
   */
  static async validateDraftPayload({ payload, baseVersion = null, dbp = prisma } = {}) {
    const parseResult = PlatformConfigPayloadSchema.safeParse(payload);
    if (!parseResult.success) {
      return {
        valid: false,
        errors: parseResult.error.issues
      };
    }

    // Determine base payload for restriction diff check
    let basePayload = DEFAULT_CONFIG_PAYLOAD;
    if (baseVersion) {
      const baseRow = await dbp.platformConfigVersion.findUnique({
        where: { version: Number(baseVersion) }
      });
      if (baseRow?.payload) {
        basePayload = baseRow.payload;
      }
    } else {
      const active = await dbp.platformConfigVersion.findFirst({
        where: { status: 'ACTIVE' },
        orderBy: { version: 'desc' }
      });
      if (active?.payload) {
        basePayload = active.payload;
      }
    }

    const checksum = generateChecksum(parseResult.data);
    const modifiedDomains = detectModifiedDomains(parseResult.data, basePayload);
    const restricted = isRestrictedDomains(modifiedDomains);

    return {
      valid: true,
      checksum,
      isRestricted: restricted,
      modifiedDomains
    };
  }

  /**
   * Creates a new configuration draft.
   */
  static async createDraft({
    authorId,
    changeReason,
    baseVersion = null,
    payload = null,
    effectiveFrom = null,
    auditTelemetry = {},
    dbp = prisma
  }) {
    if (!authorId) {
      throw new ConfigValidationError('Author ID is required to create a configuration draft');
    }

    if (!changeReason || typeof changeReason !== 'string' || changeReason.trim().length < 5) {
      throw new ConfigValidationError('A detailed change reason (minimum 5 characters) is required');
    }

    // Determine base payload
    let candidatePayload = payload;
    let basePayload = DEFAULT_CONFIG_PAYLOAD;

    if (baseVersion) {
      const baseRow = await dbp.platformConfigVersion.findUnique({
        where: { version: Number(baseVersion) }
      });
      if (!baseRow) {
        throw new ConfigValidationError(`Base configuration version ${baseVersion} not found`);
      }
      basePayload = baseRow.payload;
      if (!candidatePayload) {
        candidatePayload = structuredClone(baseRow.payload);
      }
    } else if (!candidatePayload) {
      const activeRow = await this.getActiveConfig({ dbp });
      basePayload = activeRow.payload;
      candidatePayload = structuredClone(activeRow.payload);
    }

    // Validate payload
    const parseResult = PlatformConfigPayloadSchema.safeParse(candidatePayload);
    if (!parseResult.success) {
      throw new ConfigValidationError('Configuration payload validation failed', parseResult.error.issues);
    }

    const validatedPayload = parseResult.data;
    const checksum = generateChecksum(validatedPayload);
    const modifiedDomains = detectModifiedDomains(validatedPayload, basePayload);
    const restricted = isRestrictedDomains(modifiedDomains);

    // Concurrency-safe atomic version allocation
    const nextVersion = await this.allocateNextVersion(dbp);

    let parsedEffective = null;
    if (effectiveFrom) {
      const d = new Date(effectiveFrom);
      if (!Number.isNaN(d.getTime())) {
        parsedEffective = d;
      }
    }

    const draft = await dbp.platformConfigVersion.create({
      data: {
        version: nextVersion,
        status: 'DRAFT',
        checksum,
        payload: validatedPayload,
        changeReason: changeReason.trim(),
        effectiveFrom: parsedEffective,
        isRestricted: restricted,
        modifiedDomains,
        authorId
      },
      include: {
        author: { select: { id: true, email: true, username: true } }
      }
    });

    // Record audit event
    await recordAdminAction({
      adminId: authorId,
      action: 'config.draft.created',
      outcome: 'SUCCESS',
      targetType: 'PlatformConfigVersion',
      targetId: draft.id,
      metadata: {
        version: draft.version,
        isRestricted: draft.isRestricted,
        modifiedDomains: draft.modifiedDomains,
        checksum: draft.checksum,
        changeReason: draft.changeReason
      },
      ...auditTelemetry,
      dbp
    });

    logger.info({ draftId: draft.id, version: draft.version, authorId }, 'Created configuration draft');
    return draft;
  }

  /**
   * Updates an existing configuration draft.
   * Enforces immutability: fails if status !== 'DRAFT'.
   */
  static async updateDraft({
    draftId,
    authorId,
    payload = null,
    changeReason = null,
    effectiveFrom = undefined,
    auditTelemetry = {},
    dbp = prisma
  }) {
    const draft = await dbp.platformConfigVersion.findUnique({
      where: { id: draftId }
    });

    if (!draft) {
      throw new DraftNotFoundError(`Draft with ID ${draftId} does not exist`);
    }

    // Enforce Immutability: Submitted, pending, activated, or superseded versions cannot be edited in-place
    if (draft.status !== 'DRAFT') {
      throw new ImmutableVersionError(
        `Version ${draft.version} is in status ${draft.status} and cannot be modified. Only DRAFT versions can be edited.`
      );
    }

    let updatedPayload = draft.payload;
    if (payload) {
      const merged = { ...draft.payload, ...payload };
      const parseResult = PlatformConfigPayloadSchema.safeParse(merged);
      if (!parseResult.success) {
        throw new ConfigValidationError('Updated configuration payload validation failed', parseResult.error.issues);
      }
      updatedPayload = parseResult.data;
    }

    const checksum = generateChecksum(updatedPayload);
    const activeRow = await dbp.platformConfigVersion.findFirst({
      where: { status: 'ACTIVE' },
      orderBy: { version: 'desc' }
    });
    const modifiedDomains = detectModifiedDomains(updatedPayload, activeRow?.payload ?? DEFAULT_CONFIG_PAYLOAD);
    const restricted = isRestrictedDomains(modifiedDomains);

    const updateData = {
      payload: updatedPayload,
      checksum,
      isRestricted: restricted,
      modifiedDomains
    };

    if (changeReason && typeof changeReason === 'string' && changeReason.trim().length >= 5) {
      updateData.changeReason = changeReason.trim();
    }

    if (effectiveFrom !== undefined) {
      if (effectiveFrom === null) {
        updateData.effectiveFrom = null;
      } else {
        const d = new Date(effectiveFrom);
        if (!Number.isNaN(d.getTime())) {
          updateData.effectiveFrom = d;
        }
      }
    }

    const updated = await dbp.platformConfigVersion.update({
      where: { id: draftId },
      data: updateData,
      include: {
        author: { select: { id: true, email: true, username: true } }
      }
    });

    // Record audit event
    await recordAdminAction({
      adminId: authorId,
      action: 'config.draft.updated',
      outcome: 'SUCCESS',
      targetType: 'PlatformConfigVersion',
      targetId: updated.id,
      metadata: {
        version: updated.version,
        isRestricted: updated.isRestricted,
        modifiedDomains: updated.modifiedDomains,
        checksum: updated.checksum
      },
      ...auditTelemetry,
      dbp
    });

    return updated;
  }

  /**
   * Discards an unsubmitted configuration draft.
   */
  static async deleteDraft({ draftId, actorId, auditTelemetry = {}, dbp = prisma }) {
    const draft = await dbp.platformConfigVersion.findUnique({
      where: { id: draftId }
    });

    if (!draft) {
      throw new DraftNotFoundError(`Draft with ID ${draftId} does not exist`);
    }

    if (draft.status !== 'DRAFT') {
      throw new ImmutableVersionError(
        `Version ${draft.version} has status ${draft.status}. Only DRAFT versions can be discarded.`
      );
    }

    await dbp.platformConfigVersion.delete({
      where: { id: draftId }
    });

    await recordAdminAction({
      adminId: actorId,
      action: 'config.draft.deleted',
      outcome: 'SUCCESS',
      targetType: 'PlatformConfigVersion',
      targetId: draftId,
      metadata: { version: draft.version },
      ...auditTelemetry,
      dbp
    });

    return { deleted: true, draftId, version: draft.version };
  }
}
