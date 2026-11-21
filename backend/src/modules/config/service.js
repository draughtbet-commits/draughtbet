import prisma from '../../utils/db.js';
import logger from '../../utils/logger.js';
import redis, { isRedisReady } from '../../utils/redis.js';
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

export class ConfigConflictError extends Error {
  constructor(message = 'Configuration state conflict') {
    super(message);
    this.name = 'ConfigConflictError';
    this.status = 409;
  }
}

export class MakerCheckerViolationError extends Error {
  constructor(message = 'Author cannot review their own configuration proposal. Independent reviewer required.') {
    super(message);
    this.name = 'MakerCheckerViolationError';
    this.status = 403;
  }
}

// Transaction-scoped PostgreSQL advisory lock key used to serialize all
// configuration activations so two concurrent activations can never interleave.
const CONFIG_ACTIVATION_LOCK_KEY = 4815162342n;

const isConcurrencyConflictPrismaError = (err) => {
  const code = err?.code;
  const msg = String(err?.message || '');
  return (
    code === 'P2002' ||
    code === 'P2025' ||
    code === 'P2034' ||
    msg.includes('platform_config_single_active_idx') ||
    msg.includes('could not serialize access')
  );
};

export class ConfigService {
  static async acquireConfigActivationLock(tx) {
    if (typeof tx.$queryRaw === 'function') {
      await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(${CONFIG_ACTIVATION_LOCK_KEY})) AS _cfg_lock`;
    }
  }

  static async lockConfigVersionRow(tx, versionId) {
    if (typeof tx.$queryRaw === 'function') {
      await tx.$queryRaw`SELECT id FROM "PlatformConfigVersion" WHERE id = ${versionId} FOR UPDATE`;
    }
  }

  static async runInTransaction(dbp, fn) {
    if (typeof dbp.$transaction === 'function') {
      return dbp.$transaction(fn);
    }
    return fn(dbp);
  }
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
   * Preserves existing PlatformSettings singleton values if present and schema-valid.
   * Handles concurrent application startups without duplicating versions or failing.
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

    // Inspect existing PlatformSettings to preserve legacy values if present
    let payload = structuredClone(DEFAULT_CONFIG_PAYLOAD);
    try {
      const legacySettings = await dbp.platformSettings.findUnique({
        where: { id: 'singleton' }
      });

      if (legacySettings) {
        const candidate = structuredClone(DEFAULT_CONFIG_PAYLOAD);
        if (Number.isInteger(legacySettings.commissionPercent)) {
          candidate.financial.commissionPercent = legacySettings.commissionPercent;
        }
        if (Number.isInteger(legacySettings.limitRaiseCoolingHours)) {
          candidate.saferPlay.limitRaiseCoolingHours = legacySettings.limitRaiseCoolingHours;
        }
        if (Number.isInteger(legacySettings.timeControlSeconds)) {
          candidate.game.timeControlSeconds = legacySettings.timeControlSeconds;
        }
        if (legacySettings.amateurStakeMinP != null) {
          candidate.tiers.AMATEUR.minStake = String(legacySettings.amateurStakeMinP);
        }
        if (legacySettings.amateurStakeMaxP != null) {
          candidate.tiers.AMATEUR.maxStake = String(legacySettings.amateurStakeMaxP);
        }
        if (legacySettings.masterStakeMinP != null) {
          candidate.tiers.MASTER.minStake = String(legacySettings.masterStakeMinP);
        }
        if (legacySettings.masterStakeMaxP != null) {
          candidate.tiers.MASTER.maxStake = String(legacySettings.masterStakeMaxP);
        }
        if (legacySettings.proStakeMinP != null) {
          candidate.tiers.PRO.minStake = String(legacySettings.proStakeMinP);
        }
        if (legacySettings.proStakeMaxP != null) {
          candidate.tiers.PRO.maxStake = String(legacySettings.proStakeMaxP);
        }
        if (legacySettings.amateurCalloutMaxP != null) {
          candidate.tiers.AMATEUR.maxCallout = String(legacySettings.amateurCalloutMaxP);
        }
        if (legacySettings.masterCalloutMaxP != null) {
          candidate.tiers.MASTER.maxCallout = String(legacySettings.masterCalloutMaxP);
        }
        if (legacySettings.proCalloutMaxP != null) {
          candidate.tiers.PRO.maxCallout = String(legacySettings.proCalloutMaxP);
        }

        const parsed = PlatformConfigPayloadSchema.safeParse(candidate);
        if (parsed.success) {
          payload = parsed.data;
          logger.info('Preserved existing PlatformSettings into initial PlatformConfigVersion payload');
        } else {
          logger.warn(
            { issues: parsed.error.issues },
            'Existing PlatformSettings values failed schema validation; falling back safely to DEFAULT_CONFIG_PAYLOAD'
          );
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Could not read legacy PlatformSettings during seed; using DEFAULT_CONFIG_PAYLOAD');
    }

    const checksum = generateChecksum(payload);

    try {
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

      // Synchronize legacy PlatformSettings singleton row
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
    } catch (err) {
      // Handle concurrent application startup race conditions gracefully
      const activeNow = await dbp.platformConfigVersion.findFirst({
        where: { status: 'ACTIVE' },
        orderBy: { version: 'desc' }
      });
      if (activeNow) {
        return activeNow;
      }
      throw err;
    }
  }

  /**
   * Retrieves the currently active configuration version.
   * Checks Redis cache-aside first, falls back to PostgreSQL on cache miss or Redis outage,
   * performs strict SHA-256 checksum integrity verification, and primes the cache.
   */
  static async getActiveConfig({ dbp = prisma, bypassCache = false } = {}) {
    // 1. Try Redis cache if available and not explicitly bypassed
    if (!bypassCache && dbp === prisma && isRedisReady()) {
      try {
        const cachedStr = await redis.get('config:active:v2');
        if (cachedStr) {
          const cached = JSON.parse(cachedStr);
          if (cached && cached.payload && cached.checksum && verifyChecksum(cached.payload, cached.checksum)) {
            return cached;
          }
          logger.warn('Cached active config failed checksum verification; purging invalid Redis key');
          await redis.del('config:active:v2');
        }
      } catch (err) {
        logger.warn({ err: err.message }, 'Redis read error in getActiveConfig; falling back to PostgreSQL');
      }
    }

    // 2. Query PostgreSQL
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

    // 3. Strict SHA-256 integrity verification
    if (!verifyChecksum(active.payload, active.checksum)) {
      logger.error(
        { version: active.version, storedChecksum: active.checksum },
        'Active configuration failed SHA-256 integrity check'
      );
      throw new ChecksumIntegrityError(
        `Active configuration version ${active.version} failed integrity verification`
      );
    }

    // 4. Prime Redis cache (asynchronous / best-effort)
    if (!bypassCache && dbp === prisma && isRedisReady()) {
      redis.set('config:active:v2', JSON.stringify({
        id: active.id,
        version: active.version,
        status: active.status,
        checksum: active.checksum,
        payload: active.payload,
        changeReason: active.changeReason,
        isRestricted: active.isRestricted,
        modifiedDomains: active.modifiedDomains,
        activatedAt: active.activatedAt,
        activatedById: active.activatedById,
        createdAt: active.createdAt
      }), 'EX', 3600).catch((err) => {
        logger.warn({ err: err.message }, 'Failed to prime Redis config:active:v2 cache');
      });
    }

    return active;
  }

  /**
   * Explicitly evicts active configuration from Redis cache.
   */
  static async invalidateCache() {
    if (isRedisReady()) {
      try {
        await redis.del('config:active:v2');
      } catch (err) {
        logger.warn({ err: err.message }, 'Failed to delete Redis active config key');
      }
    }
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
          approvals: {
            include: {
              reviewer: {
                select: { id: true, email: true, username: true }
              }
            }
          },
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
   * Retrieves a single configuration version by business version number or UUID.
   */
  static async getVersionByNumber(versionNumber, { dbp = prisma } = {}) {
    const isUuid = typeof versionNumber === 'string' && /^[0-9a-f-]{36}$/i.test(versionNumber.trim());
    let whereClause;
    if (isUuid) {
      whereClause = { id: versionNumber.trim() };
    } else {
      const num = Number.parseInt(versionNumber, 10);
      if (Number.isNaN(num) || num <= 0) {
        throw new ConfigValidationError('Version must be a positive integer');
      }
      whereClause = { version: num };
    }

    const version = await dbp.platformConfigVersion.findUnique({
      where: whereClause,
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

    const parseResult = PlatformConfigPayloadSchema.safeParse(candidatePayload);
    if (!parseResult.success) {
      throw new ConfigValidationError('Configuration payload validation failed', parseResult.error.issues);
    }

    const validatedPayload = parseResult.data;
    const checksum = generateChecksum(validatedPayload);
    const modifiedDomains = detectModifiedDomains(validatedPayload, basePayload);
    const restricted = isRestrictedDomains(modifiedDomains);

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
   * Updates an existing configuration draft atomically inside a transaction.
   * Locks the row and enforces immutability inside the transaction so concurrent
   * submitDraft calls cannot race with payload edits.
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
    try {
      return await this.runInTransaction(dbp, async (tx) => {
        await this.lockConfigVersionRow(tx, draftId);
        const draft = await tx.platformConfigVersion.findUnique({
          where: { id: draftId }
        });

        if (!draft) {
          throw new DraftNotFoundError(`Draft with ID ${draftId} does not exist`);
        }

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
        const activeRow = await tx.platformConfigVersion.findFirst({
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

        const updated = await tx.platformConfigVersion.update({
          where: { id: draftId, status: 'DRAFT' },
          data: updateData,
          include: {
            author: { select: { id: true, email: true, username: true } }
          }
        });

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
          dbp: tx
        });

        return updated;
      });
    } catch (err) {
      if (isConcurrencyConflictPrismaError(err)) {
        throw new ImmutableVersionError('Draft status changed concurrently and can no longer be edited.');
      }
      throw err;
    }
  }

  /**
   * Discards an unsubmitted configuration draft atomically inside a transaction.
   */
  static async deleteDraft({ draftId, actorId, auditTelemetry = {}, dbp = prisma }) {
    try {
      return await this.runInTransaction(dbp, async (tx) => {
        await this.lockConfigVersionRow(tx, draftId);
        const draft = await tx.platformConfigVersion.findUnique({
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

        await tx.platformConfigVersion.delete({
          where: { id: draftId, status: 'DRAFT' }
        });

        await recordAdminAction({
          adminId: actorId,
          action: 'config.draft.deleted',
          outcome: 'SUCCESS',
          targetType: 'PlatformConfigVersion',
          targetId: draftId,
          metadata: { version: draft.version },
          ...auditTelemetry,
          dbp: tx
        });

        return { deleted: true, draftId, version: draft.version };
      });
    } catch (err) {
      if (isConcurrencyConflictPrismaError(err)) {
        throw new ImmutableVersionError('Draft status changed concurrently and cannot be discarded.');
      }
      throw err;
    }
  }

  /**
   * Submits an un-submitted configuration draft for formal maker-checker review
   * atomically inside a transaction with row locking and checksum verification.
   * Transitions status from DRAFT -> PENDING_APPROVAL. Immutability takes effect immediately.
   */
  static async submitDraft({ draftId, authorId, auditTelemetry = {}, dbp = prisma }) {
    try {
      const submitted = await this.runInTransaction(dbp, async (tx) => {
        await this.lockConfigVersionRow(tx, draftId);
        const draft = await tx.platformConfigVersion.findUnique({
          where: { id: draftId }
        });

        if (!draft) {
          throw new DraftNotFoundError(`Draft with ID ${draftId} does not exist`);
        }

        if (draft.status !== 'DRAFT') {
          throw new ConfigConflictError(
            `Version ${draft.version} is in status ${draft.status}. Only DRAFT configurations can be submitted for approval.`
          );
        }

        // Re-validate payload integrity inside the locked transaction
        const parseResult = PlatformConfigPayloadSchema.safeParse(draft.payload);
        if (!parseResult.success) {
          throw new ConfigValidationError('Draft payload validation failed', parseResult.error.issues);
        }

        const calculatedChecksum = generateChecksum(parseResult.data);
        if (calculatedChecksum !== draft.checksum) {
          throw new ChecksumIntegrityError('Stored draft checksum does not match canonical payload checksum');
        }

        const updated = await tx.platformConfigVersion.update({
          where: { id: draftId, status: 'DRAFT', checksum: draft.checksum },
          data: {
            status: 'PENDING_APPROVAL'
          },
          include: {
            author: { select: { id: true, email: true, username: true } }
          }
        });

        await recordAdminAction({
          adminId: authorId,
          action: 'config.draft.submitted',
          outcome: 'SUCCESS',
          targetType: 'PlatformConfigVersion',
          targetId: updated.id,
          metadata: {
            version: updated.version,
            checksum: updated.checksum,
            isRestricted: updated.isRestricted,
            modifiedDomains: updated.modifiedDomains
          },
          ...auditTelemetry,
          dbp: tx
        });

        return updated;
      });

      logger.info({ draftId: submitted.id, version: submitted.version, authorId }, 'Configuration draft submitted for approval');
      return submitted;
    } catch (err) {
      if (isConcurrencyConflictPrismaError(err)) {
        throw new ConfigConflictError('Configuration draft changed concurrently during submission.');
      }
      throw err;
    }
  }

  /**
   * Approves a submitted configuration proposal atomically inside a locked transaction.
   * Strictly enforces Author/Reviewer separation and SHA-256 payload checksum binding
   * inside the transaction to eliminate TOCTOU races with concurrent reject/edit/approve.
   */
  static async approveVersion({
    versionId,
    reviewerId,
    reviewNote = null,
    clientChecksum = null,
    auditTelemetry = {},
    dbp = prisma
  }) {
    if (!reviewerId) {
      throw new ConfigValidationError('Reviewer ID is required to approve a configuration version');
    }

    let result;
    try {
      result = await this.runInTransaction(dbp, async (tx) => {
        await this.lockConfigVersionRow(tx, versionId);
        const version = await tx.platformConfigVersion.findUnique({
          where: { id: versionId }
        });

        if (!version) {
          throw new DraftNotFoundError(`Configuration version ${versionId} does not exist`);
        }

        if (version.status !== 'PENDING_APPROVAL') {
          throw new ConfigConflictError(
            `Configuration version ${version.version} is in status ${version.status}. Only PENDING_APPROVAL versions can be approved.`
          );
        }

        // Strict Maker-Checker Rule: Author cannot review or approve their own proposal
        if (version.authorId === reviewerId) {
          throw new MakerCheckerViolationError(
            'Author cannot approve their own configuration proposal. Independent reviewer is required.'
          );
        }

        // Verify SHA-256 canonical payload checksum inside the locked transaction
        if (!verifyChecksum(version.payload, version.checksum)) {
          throw new ChecksumIntegrityError(
            `Configuration version ${version.version} payload failed checksum integrity verification`
          );
        }

        // If client supplied a checksum, verify exact match
        if (clientChecksum && clientChecksum !== version.checksum) {
          throw new ChecksumIntegrityError(
            `Reviewer provided checksum ${clientChecksum} does not match server canonical checksum ${version.checksum}`
          );
        }

        const now = new Date();
        const approval = await tx.configApproval.create({
          data: {
            versionId: version.id,
            reviewerId,
            status: 'APPROVED',
            checksum: version.checksum,
            reviewNote: reviewNote ? reviewNote.trim() : null,
            reviewedAt: now
          },
          include: {
            reviewer: { select: { id: true, email: true, username: true } }
          }
        });

        const updatedVersion = await tx.platformConfigVersion.update({
          where: { id: version.id, status: 'PENDING_APPROVAL', checksum: version.checksum },
          data: {
            status: 'APPROVED'
          },
          include: {
            author: { select: { id: true, email: true, username: true } },
            approvals: {
              include: {
                reviewer: { select: { id: true, email: true, username: true } }
              }
            }
          }
        });

        await recordAdminAction({
          adminId: reviewerId,
          action: 'config.version.approved',
          outcome: 'SUCCESS',
          targetType: 'PlatformConfigVersion',
          targetId: updatedVersion.id,
          metadata: {
            version: updatedVersion.version,
            checksum: updatedVersion.checksum,
            approvalId: approval.id,
            reviewNote: approval.reviewNote
          },
          ...auditTelemetry,
          dbp: tx
        });

        return { version: updatedVersion, approval };
      });
    } catch (err) {
      if (isConcurrencyConflictPrismaError(err)) {
        throw new ConfigConflictError('Configuration version was already reviewed or modified concurrently.');
      }
      throw err;
    }

    logger.info({ versionId: result.version.id, version: result.version.version, reviewerId }, 'Configuration version approved');
    return result;
  }

  /**
   * Rejects a submitted configuration proposal atomically inside a locked transaction.
   * Strictly enforces Author/Reviewer separation inside the transaction.
   */
  static async rejectVersion({
    versionId,
    reviewerId,
    reason,
    auditTelemetry = {},
    dbp = prisma
  }) {
    if (!reviewerId) {
      throw new ConfigValidationError('Reviewer ID is required to reject a configuration version');
    }

    if (!reason || typeof reason !== 'string' || reason.trim().length < 5) {
      throw new ConfigValidationError('A detailed rejection reason (minimum 5 characters) is required');
    }

    let result;
    try {
      result = await this.runInTransaction(dbp, async (tx) => {
        await this.lockConfigVersionRow(tx, versionId);
        const version = await tx.platformConfigVersion.findUnique({
          where: { id: versionId }
        });

        if (!version) {
          throw new DraftNotFoundError(`Configuration version ${versionId} does not exist`);
        }

        if (version.status !== 'PENDING_APPROVAL') {
          throw new ConfigConflictError(
            `Configuration version ${version.version} is in status ${version.status}. Only PENDING_APPROVAL versions can be rejected.`
          );
        }

        if (version.authorId === reviewerId) {
          throw new MakerCheckerViolationError(
            'Author cannot review their own configuration proposal. Independent reviewer is required.'
          );
        }

        const now = new Date();
        const approval = await tx.configApproval.create({
          data: {
            versionId: version.id,
            reviewerId,
            status: 'REJECTED',
            checksum: version.checksum,
            reviewNote: reason.trim(),
            reviewedAt: now
          },
          include: {
            reviewer: { select: { id: true, email: true, username: true } }
          }
        });

        const updatedVersion = await tx.platformConfigVersion.update({
          where: { id: version.id, status: 'PENDING_APPROVAL', checksum: version.checksum },
          data: {
            status: 'REJECTED'
          },
          include: {
            author: { select: { id: true, email: true, username: true } },
            approvals: {
              include: {
                reviewer: { select: { id: true, email: true, username: true } }
              }
            }
          }
        });

        await recordAdminAction({
          adminId: reviewerId,
          action: 'config.version.rejected',
          outcome: 'SUCCESS',
          targetType: 'PlatformConfigVersion',
          targetId: updatedVersion.id,
          metadata: {
            version: updatedVersion.version,
            checksum: updatedVersion.checksum,
            reason: reason.trim()
          },
          ...auditTelemetry,
          dbp: tx
        });

        return { version: updatedVersion, approval };
      });
    } catch (err) {
      if (isConcurrencyConflictPrismaError(err)) {
        throw new ConfigConflictError('Configuration version was already reviewed or modified concurrently.');
      }
      throw err;
    }

    logger.info({ versionId: result.version.id, version: result.version.version, reviewerId }, 'Configuration version rejected');
    return result;
  }

  /**
   * Atomically activates an APPROVED configuration version inside a serialized
   * ACID PostgreSQL transaction. Acquires a transaction-scoped advisory lock +
   * row lock BEFORE reading target state, re-verifying exact version/checksum/
   * schema/maker-checker approvals inside the transaction so no TOCTOU race or
   * conflicting concurrent activation can occur. Guarantees strictly one ACTIVE
   * configuration version at any point in time.
   */
  static async activateVersion({
    versionId,
    activatorId,
    expectedVersion = null,
    expectedChecksum = null,
    auditTelemetry = {},
    dbp = prisma
  }) {
    if (!activatorId) {
      throw new ConfigValidationError('Activator ID is required to activate a configuration version');
    }

    const now = new Date();
    let activatedVersion;
    try {
      activatedVersion = await this.runInTransaction(dbp, async (tx) => {
        // 0. Acquire global config-activation advisory lock + target row lock
        //    BEFORE reading any mutable state to eliminate all TOCTOU windows.
        await this.acquireConfigActivationLock(tx);
        await this.lockConfigVersionRow(tx, versionId);

        const target = await tx.platformConfigVersion.findUnique({
          where: { id: versionId },
          include: {
            approvals: true
          }
        });

        if (!target) {
          throw new DraftNotFoundError(`Configuration version ${versionId} does not exist`);
        }

        if (expectedVersion !== null && expectedVersion !== undefined) {
          const parsedExpectedVersion = Number.parseInt(String(expectedVersion), 10);
          if (Number.isNaN(parsedExpectedVersion) || parsedExpectedVersion !== target.version) {
            throw new ConfigConflictError(
              `Expected configuration version ${expectedVersion} does not match target version ${target.version}`
            );
          }
        }

        if (expectedChecksum && expectedChecksum !== target.checksum) {
          throw new ChecksumIntegrityError(
            `Provided activation checksum ${expectedChecksum} does not match target checksum ${target.checksum}`
          );
        }

        if (target.status !== 'APPROVED') {
          throw new ConfigConflictError(
            `Cannot activate configuration version ${target.version} in status ${target.status}. Only APPROVED configurations can be activated.`
          );
        }

        // Re-validate payload schema & SHA-256 checksum inside the locked transaction
        const schemaResult = PlatformConfigPayloadSchema.safeParse(target.payload);
        if (!schemaResult.success) {
          throw new ConfigValidationError(
            `Configuration version ${target.version} payload failed schema validation at activation time`,
            schemaResult.error.issues
          );
        }
        if (!verifyChecksum(target.payload, target.checksum)) {
          throw new ChecksumIntegrityError(
            `Configuration version ${target.version} payload checksum mismatch`
          );
        }

        // Re-validate approval requirements inside the locked transaction:
        // - no REJECTED approval may exist on this version
        // - must have at least one APPROVED approval bound to exact target checksum
        // - reviewer must be independent of the author (Maker-Checker invariant)
        const approvals = Array.isArray(target.approvals) ? target.approvals : [];
        if (approvals.some((a) => a.status === 'REJECTED')) {
          throw new ConfigConflictError(
            `Configuration version ${target.version} has a REJECTED review record and cannot be activated.`
          );
        }

        const checksumMatchedApprovals = approvals.filter(
          (a) => a.status === 'APPROVED' && a.checksum === target.checksum
        );
        if (checksumMatchedApprovals.length === 0) {
          throw new ChecksumIntegrityError(
            `Configuration version ${target.version} lacks a valid approval matching payload checksum ${target.checksum}`
          );
        }

        const independentApproval = checksumMatchedApprovals.find(
          (a) => !target.authorId || a.reviewerId !== target.authorId
        );
        if (!independentApproval) {
          throw new MakerCheckerViolationError(
            `Configuration version ${target.version} lacks an independent reviewer approval distinct from the author.`
          );
        }

        // 1. Supersede any currently active configuration version
        await tx.platformConfigVersion.updateMany({
          where: { status: 'ACTIVE' },
          data: {
            status: 'SUPERSEDED',
            supersededAt: now
          }
        });

        // 2. Atomically promote target version (guarded by status + checksum CAS)
        const activated = await tx.platformConfigVersion.update({
          where: {
            id: target.id,
            status: 'APPROVED',
            checksum: target.checksum
          },
          data: {
            status: 'ACTIVE',
            activatedById: activatorId,
            activatedAt: now
          },
          include: {
            author: { select: { id: true, email: true, username: true } },
            activatedBy: { select: { id: true, email: true, username: true } }
          }
        });

        // 3. Synchronize legacy PlatformSettings singleton row
        try {
          const p = activated.payload;
          await tx.platformSettings.upsert({
            where: { id: 'singleton' },
            create: {
              id: 'singleton',
              commissionPercent: p.financial.commissionPercent,
              limitRaiseCoolingHours: p.saferPlay.limitRaiseCoolingHours,
              timeControlSeconds: p.game.timeControlSeconds,
              amateurStakeMinP: BigInt(p.tiers.AMATEUR.minStake),
              amateurStakeMaxP: BigInt(p.tiers.AMATEUR.maxStake),
              masterStakeMinP: BigInt(p.tiers.MASTER.minStake),
              masterStakeMaxP: BigInt(p.tiers.MASTER.maxStake),
              proStakeMinP: BigInt(p.tiers.PRO.minStake),
              proStakeMaxP: BigInt(p.tiers.PRO.maxStake),
              amateurCalloutMaxP: BigInt(p.tiers.AMATEUR.maxCallout),
              masterCalloutMaxP: BigInt(p.tiers.MASTER.maxCallout),
              proCalloutMaxP: BigInt(p.tiers.PRO.maxCallout)
            },
            update: {
              commissionPercent: p.financial.commissionPercent,
              limitRaiseCoolingHours: p.saferPlay.limitRaiseCoolingHours,
              timeControlSeconds: p.game.timeControlSeconds,
              amateurStakeMinP: BigInt(p.tiers.AMATEUR.minStake),
              amateurStakeMaxP: BigInt(p.tiers.AMATEUR.maxStake),
              masterStakeMinP: BigInt(p.tiers.MASTER.minStake),
              masterStakeMaxP: BigInt(p.tiers.MASTER.maxStake),
              proStakeMinP: BigInt(p.tiers.PRO.minStake),
              proStakeMaxP: BigInt(p.tiers.PRO.maxStake),
              amateurCalloutMaxP: BigInt(p.tiers.AMATEUR.maxCallout),
              masterCalloutMaxP: BigInt(p.tiers.MASTER.maxCallout),
              proCalloutMaxP: BigInt(p.tiers.PRO.maxCallout)
            }
          });
        } catch (err) {
          logger.warn({ err }, 'Could not sync legacy PlatformSettings during activation');
        }

        // 4. Transactional Outbox Event inside the exact same ACID transaction
        await tx.outboxEvent.create({
          data: {
            aggregateType: 'PlatformConfigVersion',
            aggregateId: activated.id,
            eventType: 'platform.config.activated',
            payload: {
              version: activated.version,
              checksum: activated.checksum,
              payload: activated.payload,
              activatedAt: activated.activatedAt
            },
            dedupeKey: `config:activated:${activated.version}`
          }
        });

        // 5. Audit log
        await recordAdminAction({
          adminId: activatorId,
          action: 'config.version.activated',
          outcome: 'SUCCESS',
          targetType: 'PlatformConfigVersion',
          targetId: activated.id,
          metadata: {
            version: activated.version,
            checksum: activated.checksum,
            isRestricted: activated.isRestricted,
            modifiedDomains: activated.modifiedDomains,
            approvalId: independentApproval.id
          },
          ...auditTelemetry,
          dbp: tx
        });

        return activated;
      });
    } catch (err) {
      if (isConcurrencyConflictPrismaError(err)) {
        throw new ConfigConflictError(
          'Conflicting concurrent configuration activation detected. Refresh version state and retry.'
        );
      }
      throw err;
    }

    // Optimistic cache eviction/update (the outbox drainer guarantees persistent delivery asynchronously)
    if (isRedisReady()) {
      redis.set('config:active:v2', JSON.stringify(activatedVersion), 'EX', 3600).catch((err) => {
        logger.warn({ err: err.message }, 'Failed optimistic Redis write for activated config');
      });
      redis.publish('platform:config:invalidated', JSON.stringify({
        version: activatedVersion.version,
        checksum: activatedVersion.checksum,
        activatedAt: activatedVersion.activatedAt
      })).catch((err) => {
        logger.warn({ err: err.message }, 'Failed optimistic Redis publish for activated config');
      });
    }

    logger.info({ version: activatedVersion.version, checksum: activatedVersion.checksum }, 'Platform configuration version activated');
    return activatedVersion;
  }

  /**
   * Non-destructive configuration rollback.
   * Atomically creates a brand-new sequential DRAFT version (N+1) with the
   * verified historical payload and rolledBackFrom pointer. Never mutates any
   * historical configuration version row.
   */
  static async rollbackVersion({
    targetVersionNumber,
    actorId,
    reason = null,
    auditTelemetry = {},
    dbp = prisma
  }) {
    if (!actorId) {
      throw new ConfigValidationError('Actor ID is required to perform rollback');
    }

    const num = Number.parseInt(targetVersionNumber, 10);
    if (Number.isNaN(num) || num <= 0) {
      throw new ConfigValidationError('Target rollback version must be a positive integer');
    }

    const rollbackDraft = await this.runInTransaction(dbp, async (tx) => {
      const historical = await tx.platformConfigVersion.findUnique({
        where: { version: num }
      });

      if (!historical) {
        throw new DraftNotFoundError(`Historical configuration version ${num} not found`);
      }

      if (!verifyChecksum(historical.payload, historical.checksum)) {
        throw new ChecksumIntegrityError(
          `Historical version ${num} payload checksum failed integrity check`
        );
      }

      const nextVersion = await this.allocateNextVersion(tx);
      const changeReason = reason && typeof reason === 'string' && reason.trim().length >= 5
        ? reason.trim()
        : `Rollback to configuration version ${num}`;

      const active = await tx.platformConfigVersion.findFirst({
        where: { status: 'ACTIVE' },
        orderBy: { version: 'desc' }
      });
      const modifiedDomains = detectModifiedDomains(historical.payload, active?.payload ?? DEFAULT_CONFIG_PAYLOAD);
      const restricted = isRestrictedDomains(modifiedDomains);

      const created = await tx.platformConfigVersion.create({
        data: {
          version: nextVersion,
          status: 'DRAFT',
          checksum: historical.checksum,
          payload: structuredClone(historical.payload),
          changeReason,
          rolledBackFrom: num,
          isRestricted: restricted,
          modifiedDomains,
          authorId: actorId
        },
        include: {
          author: { select: { id: true, email: true, username: true } }
        }
      });

      await recordAdminAction({
        adminId: actorId,
        action: 'config.version.rolled_back',
        outcome: 'SUCCESS',
        targetType: 'PlatformConfigVersion',
        targetId: created.id,
        metadata: {
          newVersion: created.version,
          targetHistoricalVersion: num,
          checksum: created.checksum,
          changeReason
        },
        ...auditTelemetry,
        dbp: tx
      });

      return created;
    });

    logger.info(
      { newVersion: rollbackDraft.version, rolledBackFrom: num, actorId },
      'Staged rollback configuration draft'
    );
    return rollbackDraft;
  }
}
