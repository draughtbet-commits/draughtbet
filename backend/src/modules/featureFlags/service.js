import prisma from '../../utils/db.js';
import logger from '../../utils/logger.js';
import redis, { isRedisReady } from '../../utils/redis.js';
import { recordAdminAction } from '../audit/service.js';
import {
  CreateFeatureFlagSchema,
  UpdateFeatureFlagSchema,
  FeatureFlagKeySchema,
  DEFAULT_FEATURE_FLAGS,
  isProtectedInvariantFlag,
  computeRolloutBucket
} from './schema.js';

export class FeatureFlagValidationError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'FeatureFlagValidationError';
    this.status = 400;
    this.issues = issues;
  }
}

export class FeatureFlagNotFoundError extends Error {
  constructor(message = 'Feature flag not found') {
    super(message);
    this.name = 'FeatureFlagNotFoundError';
    this.status = 404;
  }
}

export class FeatureFlagConflictError extends Error {
  constructor(message = 'Feature flag state conflict') {
    super(message);
    this.name = 'FeatureFlagConflictError';
    this.status = 409;
  }
}

export class ProtectedInvariantError extends Error {
  constructor(message = 'Protected platform invariant cannot be disabled or diluted via feature flags') {
    super(message);
    this.name = 'ProtectedInvariantError';
    this.status = 403;
  }
}

const FLAG_CACHE_TTL_SECONDS = 300;
const flagCacheKey = (key) => `feature_flag:${key}:v2`;

export class FeatureFlagService {
  /**
   * Idempotently seeds baseline feature flags.
   */
  static async ensureDefaultFlags({ systemUserId = null, dbp = prisma } = {}) {
    const results = [];
    for (const def of DEFAULT_FEATURE_FLAGS) {
      try {
        const flag = await dbp.featureFlag.upsert({
          where: { key: def.key },
          create: {
            key: def.key,
            name: def.name,
            description: def.description,
            enabled: def.enabled,
            rolloutPercentage: def.rolloutPercentage,
            allowedTiers: def.allowedTiers,
            allowedRoles: def.allowedRoles,
            isKillSwitch: def.isKillSwitch,
            metadata: def.metadata,
            ...(systemUserId ? { updatedById: systemUserId } : {})
          },
          update: {}
        });
        results.push(flag);
      } catch (err) {
        logger.warn({ err, key: def.key }, 'Could not seed default feature flag');
      }
    }
    return results;
  }

  /**
   * Evaluates admin UI visibility for a feature flag.
   *
   * SECURITY INVARIANT:
   * Feature flags control UI visibility and progressive feature rollout ONLY.
   * They NEVER grant administrative permissions or override backend RBAC (`requirePermission` / `hasPermission`).
   */
  static computeAdminVisibility(flag, adminRoles = []) {
    if (!flag) {
      return {
        visible: false,
        reason: 'FLAG_NOT_FOUND',
        grantsPermissions: false,
        rbacAuthoritative: true
      };
    }

    const enabled = flag.enabled ?? flag.isEnabled ?? false;
    if (!enabled) {
      return {
        visible: false,
        reason: flag.isKillSwitch ? 'KILL_SWITCH_ENGAGED' : 'FLAG_DISABLED',
        grantsPermissions: false,
        rbacAuthoritative: true
      };
    }

    const allowedRoles = Array.isArray(flag.allowedRoles) ? flag.allowedRoles : [];
    if (allowedRoles.length === 0) {
      return {
        visible: true,
        reason: 'ALL_ADMIN_ROLES_VISIBLE',
        grantsPermissions: false,
        rbacAuthoritative: true
      };
    }

    const normalizedCallerRoles = Array.isArray(adminRoles) ? adminRoles : [];
    if (normalizedCallerRoles.includes('SUPER_ADMIN')) {
      return {
        visible: true,
        reason: 'SUPER_ADMIN_VISIBILITY',
        grantsPermissions: false,
        rbacAuthoritative: true
      };
    }

    const matched = normalizedCallerRoles.some((r) => allowedRoles.includes(r));
    return {
      visible: matched,
      reason: matched ? 'ROLE_IN_VISIBILITY_LIST' : 'ROLE_NOT_IN_VISIBILITY_LIST',
      allowedRoles,
      grantsPermissions: false,
      rbacAuthoritative: true
    };
  }

  /**
   * Formats a feature flag record with computed invariant and visibility metadata.
   */
  static formatFlag(flag, adminRoles = null) {
    if (!flag) return null;
    const isProtectedInvariant = isProtectedInvariantFlag(flag);
    return {
      ...flag,
      isProtectedInvariant,
      ...(Array.isArray(adminRoles)
        ? { adminVisibility: this.computeAdminVisibility(flag, adminRoles) }
        : {})
    };
  }

  /**
   * Lists feature flags with optional filtering and admin role visibility annotations.
   */
  static async listFlags({
    search = null,
    enabled = undefined,
    isKillSwitch = undefined,
    adminRoles = null,
    dbp = prisma
  } = {}) {
    const where = {};

    if (typeof enabled === 'boolean') {
      where.enabled = enabled;
    }
    if (typeof isKillSwitch === 'boolean') {
      where.isKillSwitch = isKillSwitch;
    }
    if (search && typeof search === 'string' && search.trim() !== '') {
      const term = search.trim();
      where.OR = [
        { key: { contains: term, mode: 'insensitive' } },
        { name: { contains: term, mode: 'insensitive' } },
        { description: { contains: term, mode: 'insensitive' } }
      ];
    }

    const rows = await dbp.featureFlag.findMany({
      where,
      orderBy: [{ isKillSwitch: 'desc' }, { key: 'asc' }],
      include: {
        updatedBy: {
          select: { id: true, email: true, username: true }
        }
      }
    });

    return rows.map((row) => this.formatFlag(row, adminRoles));
  }

  /**
   * Retrieves a single feature flag by key, using Redis cache-aside with PostgreSQL fallback.
   */
  static async getFlagByKey(key, { dbp = prisma, bypassCache = false, adminRoles = null } = {}) {
    if (!key || typeof key !== 'string') {
      throw new FeatureFlagValidationError('Feature flag key is required');
    }
    const normalizedKey = key.trim().toLowerCase();

    if (!bypassCache && dbp === prisma && isRedisReady()) {
      try {
        const cachedStr = await redis.get(flagCacheKey(normalizedKey));
        if (cachedStr) {
          const cached = JSON.parse(cachedStr);
          if (cached && cached.key === normalizedKey) {
            return this.formatFlag(cached, adminRoles);
          }
        }
      } catch (err) {
        logger.warn({ err: err.message, key: normalizedKey }, 'Redis read error in getFlagByKey; falling back to PostgreSQL');
      }
    }

    const flag = await dbp.featureFlag.findUnique({
      where: { key: normalizedKey },
      include: {
        updatedBy: {
          select: { id: true, email: true, username: true }
        }
      }
    });

    if (!flag) {
      return null;
    }

    if (!bypassCache && dbp === prisma && isRedisReady()) {
      redis.set(flagCacheKey(normalizedKey), JSON.stringify(flag), 'EX', FLAG_CACHE_TTL_SECONDS).catch((err) => {
        logger.warn({ err: err.message, key: normalizedKey }, 'Failed to prime Redis feature flag cache');
      });
    }

    return this.formatFlag(flag, adminRoles);
  }

  /**
   * Evicts a feature flag from Redis cache and publishes invalidation notice.
   */
  static async invalidateCache(key, payload = {}) {
    if (!isRedisReady()) return;
    try {
      if (key) {
        await redis.del(flagCacheKey(key));
      }
      await redis.publish(
        'platform:feature_flag:invalidated',
        JSON.stringify({ key: key ?? null, timestamp: Date.now(), ...payload })
      );
    } catch (err) {
      logger.warn({ err: err.message, key }, 'Failed to invalidate Redis feature flag cache');
    }
  }

  /**
   * Validates invariant constraints on a candidate flag state.
   */
  static assertInvariantSafety(existingOrCandidate, targetState = {}) {
    const combined = { ...existingOrCandidate, ...targetState };
    if (!isProtectedInvariantFlag(existingOrCandidate) && !isProtectedInvariantFlag(combined)) {
      return;
    }

    const targetEnabled =
      targetState.enabled !== undefined
        ? targetState.enabled
        : targetState.isEnabled !== undefined
          ? targetState.isEnabled
          : existingOrCandidate.enabled ?? existingOrCandidate.isEnabled ?? true;

    if (targetEnabled === false) {
      throw new ProtectedInvariantError(
        `Protected platform invariant '${existingOrCandidate.key || 'invariant'}' cannot be disabled via feature flags`
      );
    }

    const targetRollout =
      targetState.rolloutPercentage !== undefined
        ? targetState.rolloutPercentage
        : existingOrCandidate.rolloutPercentage ?? 100;

    if (targetRollout < 100) {
      throw new ProtectedInvariantError(
        `Protected platform invariant '${existingOrCandidate.key || 'invariant'}' must remain at 100% rollout`
      );
    }

    const targetTiers =
      targetState.allowedTiers !== undefined
        ? targetState.allowedTiers
        : existingOrCandidate.allowedTiers ?? [];

    if (Array.isArray(targetTiers) && targetTiers.length > 0 && targetTiers.length < 3) {
      throw new ProtectedInvariantError(
        `Protected platform invariant '${existingOrCandidate.key || 'invariant'}' cannot be restricted to a subset of player tiers`
      );
    }

    if (
      isProtectedInvariantFlag(existingOrCandidate) &&
      targetState.metadata &&
      typeof targetState.metadata === 'object' &&
      targetState.metadata.isProtectedInvariant === false
    ) {
      throw new ProtectedInvariantError(
        `Cannot strip isProtectedInvariant protection from '${existingOrCandidate.key || 'invariant'}'`
      );
    }
  }

  /**
   * Creates a new feature flag with validation, transactional outbox event, and audit logging.
   */
  static async createFlag({
    key,
    name,
    description = null,
    enabled = false,
    rolloutPercentage = 100,
    allowedTiers = [],
    allowedRoles = [],
    isKillSwitch = false,
    metadata = null,
    changeReason = 'Initial feature flag creation',
    actorId,
    auditTelemetry = {},
    dbp = prisma
  }) {
    if (!actorId) {
      throw new FeatureFlagValidationError('Actor ID is required to create a feature flag');
    }

    const parsed = CreateFeatureFlagSchema.safeParse({
      key,
      name,
      description,
      enabled,
      rolloutPercentage,
      allowedTiers,
      allowedRoles,
      isKillSwitch,
      metadata,
      changeReason
    });

    if (!parsed.success) {
      throw new FeatureFlagValidationError('Feature flag validation failed', parsed.error.issues);
    }

    const valid = parsed.data;
    this.assertInvariantSafety(valid, valid);

    const existing = await dbp.featureFlag.findUnique({
      where: { key: valid.key }
    });
    if (existing) {
      throw new FeatureFlagConflictError(`Feature flag with key '${valid.key}' already exists`);
    }

    const created = await dbp.$transaction(async (tx) => {
      const flag = await tx.featureFlag.create({
        data: {
          key: valid.key,
          name: valid.name,
          description: valid.description ?? null,
          enabled: valid.enabled,
          rolloutPercentage: valid.rolloutPercentage,
          allowedTiers: valid.allowedTiers,
          allowedRoles: valid.allowedRoles,
          isKillSwitch: valid.isKillSwitch,
          metadata: valid.metadata ?? null,
          updatedById: actorId
        },
        include: {
          updatedBy: { select: { id: true, email: true, username: true } }
        }
      });

      if (tx.outboxEvent?.create) {
        await tx.outboxEvent.create({
          data: {
            aggregateType: 'FeatureFlag',
            aggregateId: flag.id,
            eventType: 'platform.feature_flag.updated',
            payload: {
              id: flag.id,
              key: flag.key,
              enabled: flag.enabled,
              rolloutPercentage: flag.rolloutPercentage,
              allowedTiers: flag.allowedTiers,
              allowedRoles: flag.allowedRoles,
              isKillSwitch: flag.isKillSwitch,
              action: 'CREATED',
              updatedAt: flag.updatedAt
            }
          }
        });
      }

      await recordAdminAction({
        adminId: actorId,
        action: 'feature_flag.created',
        outcome: 'SUCCESS',
        targetType: 'FeatureFlag',
        targetId: flag.id,
        metadata: {
          key: flag.key,
          name: flag.name,
          enabled: flag.enabled,
          rolloutPercentage: flag.rolloutPercentage,
          allowedTiers: flag.allowedTiers,
          allowedRoles: flag.allowedRoles,
          isKillSwitch: flag.isKillSwitch,
          changeReason: valid.changeReason ?? 'Initial feature flag creation'
        },
        ...auditTelemetry,
        dbp: tx
      });

      return flag;
    });

    await this.invalidateCache(created.key, { enabled: created.enabled, action: 'CREATED' });
    logger.info({ flagId: created.id, key: created.key, actorId }, 'Feature flag created');
    return this.formatFlag(created);
  }

  /**
   * Updates an existing feature flag's configuration, rollout rules, or visibility controls.
   */
  static async updateFlag({
    key,
    updates = {},
    changeReason = null,
    actorId,
    auditTelemetry = {},
    dbp = prisma
  }) {
    if (!actorId) {
      throw new FeatureFlagValidationError('Actor ID is required to update a feature flag');
    }

    const keyParse = FeatureFlagKeySchema.safeParse(key);
    if (!keyParse.success) {
      throw new FeatureFlagValidationError('Invalid feature flag key', keyParse.error.issues);
    }
    const normalizedKey = keyParse.data;

    const payloadToValidate = {
      ...updates,
      ...(changeReason !== null && changeReason !== undefined ? { changeReason } : {})
    };
    const parsed = UpdateFeatureFlagSchema.safeParse(payloadToValidate);
    if (!parsed.success) {
      throw new FeatureFlagValidationError('Feature flag update validation failed', parsed.error.issues);
    }

    const existing = await dbp.featureFlag.findUnique({
      where: { key: normalizedKey }
    });
    if (!existing) {
      throw new FeatureFlagNotFoundError(`Feature flag '${normalizedKey}' not found`);
    }

    const valid = parsed.data;
    this.assertInvariantSafety(existing, valid);

    const beforeSnapshot = {
      name: existing.name,
      description: existing.description,
      enabled: existing.enabled,
      rolloutPercentage: existing.rolloutPercentage,
      allowedTiers: existing.allowedTiers,
      allowedRoles: existing.allowedRoles,
      isKillSwitch: existing.isKillSwitch,
      metadata: existing.metadata
    };

    const updateData = {
      updatedById: actorId
    };
    if (valid.name !== undefined) updateData.name = valid.name;
    if (valid.description !== undefined) updateData.description = valid.description;
    if (valid.enabled !== undefined) updateData.enabled = valid.enabled;
    if (valid.rolloutPercentage !== undefined) updateData.rolloutPercentage = valid.rolloutPercentage;
    if (valid.allowedTiers !== undefined) updateData.allowedTiers = valid.allowedTiers;
    if (valid.allowedRoles !== undefined) updateData.allowedRoles = valid.allowedRoles;
    if (valid.isKillSwitch !== undefined) updateData.isKillSwitch = valid.isKillSwitch;
    if (valid.metadata !== undefined) {
      updateData.metadata =
        existing.metadata && typeof existing.metadata === 'object' && valid.metadata && typeof valid.metadata === 'object'
          ? { ...existing.metadata, ...valid.metadata }
          : valid.metadata;
    }

    const updated = await dbp.$transaction(async (tx) => {
      const flag = await tx.featureFlag.update({
        where: { key: normalizedKey },
        data: updateData,
        include: {
          updatedBy: { select: { id: true, email: true, username: true } }
        }
      });

      if (tx.outboxEvent?.create) {
        await tx.outboxEvent.create({
          data: {
            aggregateType: 'FeatureFlag',
            aggregateId: flag.id,
            eventType: 'platform.feature_flag.updated',
            payload: {
              id: flag.id,
              key: flag.key,
              enabled: flag.enabled,
              rolloutPercentage: flag.rolloutPercentage,
              allowedTiers: flag.allowedTiers,
              allowedRoles: flag.allowedRoles,
              isKillSwitch: flag.isKillSwitch,
              action: 'UPDATED',
              updatedAt: flag.updatedAt
            }
          }
        });
      }

      await recordAdminAction({
        adminId: actorId,
        action: 'feature_flag.updated',
        outcome: 'SUCCESS',
        targetType: 'FeatureFlag',
        targetId: flag.id,
        metadata: {
          key: flag.key,
          before: beforeSnapshot,
          after: {
            name: flag.name,
            description: flag.description,
            enabled: flag.enabled,
            rolloutPercentage: flag.rolloutPercentage,
            allowedTiers: flag.allowedTiers,
            allowedRoles: flag.allowedRoles,
            isKillSwitch: flag.isKillSwitch,
            metadata: flag.metadata
          },
          changeReason: valid.changeReason ?? 'Feature flag updated'
        },
        ...auditTelemetry,
        dbp: tx
      });

      return flag;
    });

    await this.invalidateCache(updated.key, { enabled: updated.enabled, action: 'UPDATED' });
    logger.info({ flagId: updated.id, key: updated.key, actorId }, 'Feature flag updated');
    return this.formatFlag(updated);
  }

  /**
   * Explicitly enables or disables a feature flag with mandatory audit trail.
   */
  static async toggleFlag({
    key,
    enabled,
    changeReason = null,
    actorId,
    auditTelemetry = {},
    dbp = prisma
  }) {
    if (typeof enabled !== 'boolean') {
      throw new FeatureFlagValidationError("'enabled' must be a boolean");
    }
    if (!changeReason || typeof changeReason !== 'string' || changeReason.trim().length < 5) {
      throw new FeatureFlagValidationError('A change reason of at least 5 characters is required to toggle a feature flag');
    }

    const existing = await dbp.featureFlag.findUnique({
      where: { key: String(key).trim().toLowerCase() }
    });
    if (!existing) {
      throw new FeatureFlagNotFoundError(`Feature flag '${key}' not found`);
    }

    this.assertInvariantSafety(existing, { enabled });

    const updated = await dbp.$transaction(async (tx) => {
      const flag = await tx.featureFlag.update({
        where: { key: existing.key },
        data: {
          enabled,
          updatedById: actorId
        },
        include: {
          updatedBy: { select: { id: true, email: true, username: true } }
        }
      });

      if (tx.outboxEvent?.create) {
        await tx.outboxEvent.create({
          data: {
            aggregateType: 'FeatureFlag',
            aggregateId: flag.id,
            eventType: 'platform.feature_flag.updated',
            payload: {
              id: flag.id,
              key: flag.key,
              enabled: flag.enabled,
              rolloutPercentage: flag.rolloutPercentage,
              allowedTiers: flag.allowedTiers,
              allowedRoles: flag.allowedRoles,
              isKillSwitch: flag.isKillSwitch,
              action: 'TOGGLED',
              updatedAt: flag.updatedAt
            }
          }
        });
      }

      await recordAdminAction({
        adminId: actorId,
        action: 'feature_flag.toggled',
        outcome: 'SUCCESS',
        targetType: 'FeatureFlag',
        targetId: flag.id,
        metadata: {
          key: flag.key,
          previousEnabled: existing.enabled,
          enabled: flag.enabled,
          changeReason: changeReason.trim()
        },
        ...auditTelemetry,
        dbp: tx
      });

      return flag;
    });

    await this.invalidateCache(updated.key, { enabled: updated.enabled, action: 'TOGGLED' });
    return this.formatFlag(updated);
  }

  /**
   * Emergency kill-switch operation for flags designated with `isKillSwitch: true`.
   * Accessible to operational roles holding `FLAGS_KILLSWITCH` or `FLAGS_MANAGE`.
   */
  static async triggerKillSwitch({
    key,
    enabled = false,
    reason,
    actorId,
    auditTelemetry = {},
    dbp = prisma
  }) {
    if (!actorId) {
      throw new FeatureFlagValidationError('Actor ID is required to trigger a kill switch');
    }
    if (typeof enabled !== 'boolean') {
      throw new FeatureFlagValidationError("'enabled' must be a boolean");
    }
    if (!reason || typeof reason !== 'string' || reason.trim().length < 5) {
      throw new FeatureFlagValidationError('An emergency reason of at least 5 characters is required to trigger a kill switch');
    }

    const existing = await dbp.featureFlag.findUnique({
      where: { key: String(key).trim().toLowerCase() }
    });
    if (!existing) {
      throw new FeatureFlagNotFoundError(`Feature flag '${key}' not found`);
    }

    if (!existing.isKillSwitch) {
      throw new FeatureFlagConflictError(
        `Feature flag '${existing.key}' is not designated as a kill switch`
      );
    }

    this.assertInvariantSafety(existing, { enabled });

    const updated = await dbp.$transaction(async (tx) => {
      const flag = await tx.featureFlag.update({
        where: { key: existing.key },
        data: {
          enabled,
          updatedById: actorId
        },
        include: {
          updatedBy: { select: { id: true, email: true, username: true } }
        }
      });

      if (tx.outboxEvent?.create) {
        await tx.outboxEvent.create({
          data: {
            aggregateType: 'FeatureFlag',
            aggregateId: flag.id,
            eventType: 'platform.feature_flag.updated',
            payload: {
              id: flag.id,
              key: flag.key,
              enabled: flag.enabled,
              rolloutPercentage: flag.rolloutPercentage,
              allowedTiers: flag.allowedTiers,
              allowedRoles: flag.allowedRoles,
              isKillSwitch: true,
              action: 'KILL_SWITCH_TRIGGERED',
              reason: reason.trim(),
              updatedAt: flag.updatedAt
            }
          }
        });
      }

      await recordAdminAction({
        adminId: actorId,
        action: 'feature_flag.kill_switch.triggered',
        outcome: 'SUCCESS',
        targetType: 'FeatureFlag',
        targetId: flag.id,
        metadata: {
          key: flag.key,
          previousEnabled: existing.enabled,
          enabled: flag.enabled,
          isKillSwitch: true,
          reason: reason.trim()
        },
        ...auditTelemetry,
        dbp: tx
      });

      return flag;
    });

    await this.invalidateCache(updated.key, {
      enabled: updated.enabled,
      isKillSwitch: true,
      action: 'KILL_SWITCH_TRIGGERED'
    });
    logger.warn(
      { flagId: updated.id, key: updated.key, enabled: updated.enabled, actorId, reason: reason.trim() },
      'Operational kill switch triggered'
    );
    return this.formatFlag(updated);
  }

  /**
   * Deletes a non-protected feature flag.
   */
  static async deleteFlag({
    key,
    reason,
    actorId,
    auditTelemetry = {},
    dbp = prisma
  }) {
    if (!actorId) {
      throw new FeatureFlagValidationError('Actor ID is required to delete a feature flag');
    }
    if (!reason || typeof reason !== 'string' || reason.trim().length < 5) {
      throw new FeatureFlagValidationError('A deletion reason of at least 5 characters is required');
    }

    const existing = await dbp.featureFlag.findUnique({
      where: { key: String(key).trim().toLowerCase() }
    });
    if (!existing) {
      throw new FeatureFlagNotFoundError(`Feature flag '${key}' not found`);
    }

    if (isProtectedInvariantFlag(existing)) {
      throw new ProtectedInvariantError(
        `Protected platform invariant '${existing.key}' cannot be deleted`
      );
    }

    await dbp.$transaction(async (tx) => {
      await tx.featureFlag.delete({
        where: { key: existing.key }
      });

      if (tx.outboxEvent?.create) {
        await tx.outboxEvent.create({
          data: {
            aggregateType: 'FeatureFlag',
            aggregateId: existing.id,
            eventType: 'platform.feature_flag.updated',
            payload: {
              id: existing.id,
              key: existing.key,
              enabled: false,
              action: 'DELETED',
              updatedAt: new Date()
            }
          }
        });
      }

      await recordAdminAction({
        adminId: actorId,
        action: 'feature_flag.deleted',
        outcome: 'SUCCESS',
        targetType: 'FeatureFlag',
        targetId: existing.id,
        metadata: {
          key: existing.key,
          deletedFlag: {
            name: existing.name,
            enabled: existing.enabled,
            rolloutPercentage: existing.rolloutPercentage,
            allowedTiers: existing.allowedTiers,
            allowedRoles: existing.allowedRoles,
            isKillSwitch: existing.isKillSwitch
          },
          reason: reason.trim()
        },
        ...auditTelemetry,
        dbp: tx
      });
    });

    await this.invalidateCache(existing.key, { enabled: false, action: 'DELETED' });
    return { deleted: true, key: existing.key, id: existing.id };
  }

  /**
   * Evaluates a feature flag for a specific player/subject context.
   *
   * Evaluation pipeline:
   * 1. Flag existence check -> returns `defaultValue` if not found.
   * 2. Master `enabled` boolean check -> if false, returns false immediately (`KILL_SWITCH_ENGAGED` or `FLAG_DISABLED`).
   * 3. Player Tier targeting (`allowedTiers`) -> if non-empty, `userTier` must be included.
   * 4. Deterministic percentage rollout (`rolloutPercentage`) -> SHA-256 `(key:userId)` modulo 100 `< rolloutPercentage`.
   *
   * SECURITY INVARIANT:
   * Evaluation results NEVER confer administrative permissions. Backend RBAC remains authoritative.
   */
  static async evaluateFlag(
    key,
    {
      userId = null,
      userTier = null,
      adminRoles = null,
      defaultValue = false,
      dbp = prisma
    } = {}
  ) {
    const flag = await this.getFlagByKey(key, { dbp });
    if (!flag) {
      return {
        key,
        enabled: Boolean(defaultValue),
        reason: 'FLAG_NOT_FOUND',
        rolloutPercentage: null,
        bucket: null,
        grantsPermissions: false,
        rbacAuthoritative: true
      };
    }

    const isEnabled = flag.enabled ?? flag.isEnabled ?? false;
    if (!isEnabled) {
      return {
        key: flag.key,
        enabled: false,
        reason: flag.isKillSwitch ? 'KILL_SWITCH_ENGAGED' : 'FLAG_DISABLED',
        rolloutPercentage: flag.rolloutPercentage,
        bucket: null,
        isKillSwitch: Boolean(flag.isKillSwitch),
        grantsPermissions: false,
        rbacAuthoritative: true,
        ...(Array.isArray(adminRoles)
          ? { adminVisibility: this.computeAdminVisibility(flag, adminRoles) }
          : {})
      };
    }

    // Player tier targeting check
    const allowedTiers = Array.isArray(flag.allowedTiers) ? flag.allowedTiers : [];
    if (allowedTiers.length > 0) {
      const normalizedTier = typeof userTier === 'string' ? userTier.trim().toUpperCase() : null;
      if (!normalizedTier || !allowedTiers.includes(normalizedTier)) {
        return {
          key: flag.key,
          enabled: false,
          reason: 'TIER_NOT_ELIGIBLE',
          allowedTiers,
          userTier: normalizedTier,
          rolloutPercentage: flag.rolloutPercentage,
          bucket: null,
          grantsPermissions: false,
          rbacAuthoritative: true,
          ...(Array.isArray(adminRoles)
            ? { adminVisibility: this.computeAdminVisibility(flag, adminRoles) }
            : {})
        };
      }
    }

    // Percentage rollout check
    const pct = Number.isInteger(flag.rolloutPercentage) ? flag.rolloutPercentage : 100;
    if (pct <= 0) {
      return {
        key: flag.key,
        enabled: false,
        reason: 'ZERO_PERCENT_ROLLOUT',
        rolloutPercentage: 0,
        bucket: null,
        grantsPermissions: false,
        rbacAuthoritative: true,
        ...(Array.isArray(adminRoles)
          ? { adminVisibility: this.computeAdminVisibility(flag, adminRoles) }
          : {})
      };
    }

    if (pct >= 100) {
      const bucket = userId ? computeRolloutBucket(flag.key, userId) : null;
      return {
        key: flag.key,
        enabled: true,
        reason: 'FULL_ROLLOUT',
        rolloutPercentage: 100,
        bucket,
        grantsPermissions: false,
        rbacAuthoritative: true,
        ...(Array.isArray(adminRoles)
          ? { adminVisibility: this.computeAdminVisibility(flag, adminRoles) }
          : {})
      };
    }

    // Partial percentage rollout (1..99%) requires deterministic subject identifier
    if (!userId || String(userId).trim() === '') {
      return {
        key: flag.key,
        enabled: false,
        reason: 'SUBJECT_ID_REQUIRED_FOR_PARTIAL_ROLLOUT',
        rolloutPercentage: pct,
        bucket: null,
        grantsPermissions: false,
        rbacAuthoritative: true,
        ...(Array.isArray(adminRoles)
          ? { adminVisibility: this.computeAdminVisibility(flag, adminRoles) }
          : {})
      };
    }

    const bucket = computeRolloutBucket(flag.key, userId);
    const inCohort = bucket < pct;

    return {
      key: flag.key,
      enabled: inCohort,
      reason: inCohort ? 'ROLLOUT_COHORT_MATCH' : 'ROLLOUT_COHORT_EXCLUDED',
      rolloutPercentage: pct,
      bucket,
      grantsPermissions: false,
      rbacAuthoritative: true,
      ...(Array.isArray(adminRoles)
        ? { adminVisibility: this.computeAdminVisibility(flag, adminRoles) }
        : {})
    };
  }

  /**
   * Retrieves paginated audit history for a specific feature flag.
   */
  static async getFlagHistory(key, { page = 1, limit = 20, dbp = prisma } = {}) {
    const normalizedKey = String(key ?? '').trim().toLowerCase();
    if (!normalizedKey) {
      throw new FeatureFlagValidationError('Feature flag key is required');
    }

    const flag = await dbp.featureFlag.findUnique({
      where: { key: normalizedKey },
      select: { id: true, key: true, name: true }
    });

    const skip = (Math.max(1, page) - 1) * Math.max(1, limit);
    const take = Math.min(100, Math.max(1, limit));

    const where = flag
      ? {
          targetType: 'FeatureFlag',
          OR: [
            { targetId: flag.id },
            { metadata: { path: ['key'], equals: normalizedKey } }
          ]
        }
      : {
          targetType: 'FeatureFlag',
          metadata: { path: ['key'], equals: normalizedKey }
        };

    const [rows, total] = await Promise.all([
      dbp.adminAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take
      }),
      dbp.adminAuditLog.count({ where })
    ]);

    return {
      flag: flag ?? { key: normalizedKey },
      history: rows,
      total,
      page: Math.max(1, page),
      totalPages: Math.ceil(total / take)
    };
  }
}
