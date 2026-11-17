import prisma from '../../utils/db.js';
import logger from '../../utils/logger.js';
import redis, { isRedisReady } from '../../utils/redis.js';
import { recordAdminAction } from '../audit/service.js';
import {
  DEFAULT_MAINTENANCE_STATE,
  PROTECTED_EXEMPT_PREFIXES,
  SCOPE_RESTRICTED_PREFIXES,
  MaintenanceConfigInputSchema
} from './schema.js';

export class MaintenanceValidationError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'MaintenanceValidationError';
    this.status = 400;
    this.issues = issues;
  }
}

export class MaintenanceLockoutProtectionError extends Error {
  constructor(
    message = 'Lockout protection: SUPER_ADMIN access and authentication surfaces cannot be disabled during maintenance'
  ) {
    super(message);
    this.name = 'MaintenanceLockoutProtectionError';
    this.status = 403;
  }
}

export class MaintenanceConflictError extends Error {
  constructor(message = 'Maintenance state conflict') {
    super(message);
    this.name = 'MaintenanceConflictError';
    this.status = 409;
  }
}

const MAINTENANCE_CACHE_KEY = 'maintenance:state:v2';
const MAINTENANCE_CACHE_TTL_SECONDS = 300;

export class MaintenanceService {
  /**
   * Computes the effective operational status of maintenance mode at `now`.
   *
   * Statuses:
   * - `INACTIVE`: `active === false`
   * - `SCHEDULED`: `active === true` and `startsAt` is in the future (`now < startsAt`)
   * - `ACTIVE`: `active === true`, `startsAt` has passed (or is null), and `endsAt` has not passed (or is null)
   * - `EXPIRED`: `active === true` and `endsAt` is in the past (`now >= endsAt`)
   */
  static computeEffectiveState(rawState = DEFAULT_MAINTENANCE_STATE, now = new Date()) {
    const state = rawState ? { ...DEFAULT_MAINTENANCE_STATE, ...rawState } : { ...DEFAULT_MAINTENANCE_STATE };
    const isActiveFlag = Boolean(state.active ?? state.isEnabled ?? false);

    // Guarantee SUPER_ADMIN is always present in allowedRoles
    const rawRoles = Array.isArray(state.allowedRoles) ? state.allowedRoles : ['SUPER_ADMIN'];
    const allowedRoles = rawRoles.includes('SUPER_ADMIN')
      ? rawRoles
      : ['SUPER_ADMIN', ...rawRoles];

    const startsAtDate = state.startsAt ? new Date(state.startsAt) : null;
    const endsAtDate = state.endsAt ? new Date(state.endsAt) : null;
    const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();

    let effectiveStatus = 'INACTIVE';
    let effectivelyActive = false;

    if (isActiveFlag) {
      if (startsAtDate && !Number.isNaN(startsAtDate.getTime()) && nowMs < startsAtDate.getTime()) {
        effectiveStatus = 'SCHEDULED';
        effectivelyActive = false;
      } else if (endsAtDate && !Number.isNaN(endsAtDate.getTime()) && nowMs >= endsAtDate.getTime()) {
        effectiveStatus = 'EXPIRED';
        effectivelyActive = false;
      } else {
        effectiveStatus = 'ACTIVE';
        effectivelyActive = true;
      }
    }

    const scope = state.scope || 'FULL_PLATFORM';
    const restrictedPrefixes =
      SCOPE_RESTRICTED_PREFIXES[scope] ?? SCOPE_RESTRICTED_PREFIXES.FULL_PLATFORM;

    return {
      ...state,
      active: isActiveFlag,
      scope,
      allowedRoles,
      allowedIps: Array.isArray(state.allowedIps) ? state.allowedIps : [],
      effectiveStatus,
      effectivelyActive,
      exemptPrefixes: PROTECTED_EXEMPT_PREFIXES,
      restrictedPrefixes
    };
  }

  /**
   * Retrieves the current maintenance state, using Redis cache-aside with PostgreSQL fallback.
   */
  static async getMaintenanceState({
    dbp = prisma,
    bypassCache = false,
    now = new Date()
  } = {}) {
    if (!bypassCache && dbp === prisma && isRedisReady()) {
      try {
        const cachedStr = await redis.get(MAINTENANCE_CACHE_KEY);
        if (cachedStr) {
          const cached = JSON.parse(cachedStr);
          if (cached && cached.id === 'singleton') {
            return this.computeEffectiveState(cached, now);
          }
        }
      } catch (err) {
        logger.warn({ err: err.message }, 'Redis read error in getMaintenanceState; falling back to PostgreSQL');
      }
    }

    let row = null;
    if (dbp.maintenanceState?.findUnique) {
      row = await dbp.maintenanceState.findUnique({
        where: { id: 'singleton' },
        include: {
          updatedBy: { select: { id: true, email: true, username: true } }
        }
      });
    }

    const baseState = row ?? DEFAULT_MAINTENANCE_STATE;

    if (!bypassCache && dbp === prisma && isRedisReady() && row) {
      redis.set(MAINTENANCE_CACHE_KEY, JSON.stringify(row), 'EX', MAINTENANCE_CACHE_TTL_SECONDS).catch((err) => {
        logger.warn({ err: err.message }, 'Failed to prime Redis maintenance state cache');
      });
    }

    return this.computeEffectiveState(baseState, now);
  }

  /**
   * Evicts or updates the Redis maintenance state cache and publishes invalidation.
   */
  static async invalidateCache(payload = {}) {
    if (!isRedisReady()) return;
    try {
      await redis.del(MAINTENANCE_CACHE_KEY);
      await redis.publish(
        'platform:maintenance:invalidated',
        JSON.stringify({ timestamp: Date.now(), ...payload })
      );
    } catch (err) {
      logger.warn({ err: err.message }, 'Failed to invalidate Redis maintenance cache');
    }
  }

  /**
   * Updates maintenance configuration (enable, disable, scope, schedule window, banner message, allowed IPs/roles).
   * Enforces accidental platform lockout protections.
   */
  static async updateMaintenanceState({
    active,
    scope,
    headline,
    message,
    allowedIps,
    allowedRoles,
    startsAt,
    endsAt,
    reason = null,
    changeReason = null,
    actorId,
    auditAction = null,
    auditTelemetry = {},
    now = new Date(),
    dbp = prisma
  }) {
    if (!actorId) {
      throw new MaintenanceValidationError('Actor ID is required to update maintenance controls');
    }

    // Explicit lockout protection check before schema validation
    if (Array.isArray(allowedRoles) && !allowedRoles.includes('SUPER_ADMIN')) {
      throw new MaintenanceLockoutProtectionError(
        'Lockout protection: SUPER_ADMIN must always be included in allowedRoles to prevent platform lockout'
      );
    }

    const effectiveReason = reason ?? changeReason;
    if (!effectiveReason || typeof effectiveReason !== 'string' || effectiveReason.trim().length < 5) {
      throw new MaintenanceValidationError('A reason of at least 5 characters is required for maintenance changes');
    }

    const existingRow = dbp.maintenanceState?.findUnique
      ? await dbp.maintenanceState.findUnique({ where: { id: 'singleton' } })
      : null;
    const base = existingRow ?? DEFAULT_MAINTENANCE_STATE;

    const mergedStartsAt = startsAt !== undefined ? startsAt : base.startsAt;
    const mergedEndsAt = endsAt !== undefined ? endsAt : base.endsAt;

    const parsed = MaintenanceConfigInputSchema.safeParse({
      ...(active !== undefined ? { active } : {}),
      ...(scope !== undefined ? { scope } : {}),
      ...(headline !== undefined ? { headline } : {}),
      ...(message !== undefined ? { message } : {}),
      ...(allowedIps !== undefined ? { allowedIps } : {}),
      ...(allowedRoles !== undefined ? { allowedRoles } : {}),
      startsAt: mergedStartsAt instanceof Date ? mergedStartsAt.toISOString() : mergedStartsAt,
      endsAt: mergedEndsAt instanceof Date ? mergedEndsAt.toISOString() : mergedEndsAt,
      reason: effectiveReason.trim()
    });

    if (!parsed.success) {
      throw new MaintenanceValidationError('Maintenance configuration validation failed', parsed.error.issues);
    }

    const valid = parsed.data;
    const nextActive = valid.active !== undefined ? valid.active : Boolean(base.active);
    const nextScope = valid.scope ?? base.scope ?? 'FULL_PLATFORM';
    const nextHeadline = valid.headline ?? base.headline ?? DEFAULT_MAINTENANCE_STATE.headline;
    const nextMessage = valid.message ?? base.message ?? DEFAULT_MAINTENANCE_STATE.message;
    const nextAllowedIps = valid.allowedIps ?? base.allowedIps ?? [];
    const rawNextRoles = valid.allowedRoles ?? base.allowedRoles ?? ['SUPER_ADMIN'];
    const nextAllowedRoles = rawNextRoles.includes('SUPER_ADMIN')
      ? rawNextRoles
      : ['SUPER_ADMIN', ...rawNextRoles];

    const nextStartsAt =
      startsAt === null
        ? null
        : valid.startsAt
          ? new Date(valid.startsAt)
          : null;
    const nextEndsAt =
      endsAt === null
        ? null
        : valid.endsAt
          ? new Date(valid.endsAt)
          : null;

    // Determine specific audit action name
    let resolvedAuditAction = auditAction;
    if (!resolvedAuditAction) {
      if (!base.active && nextActive) {
        resolvedAuditAction =
          nextStartsAt && nextStartsAt.getTime() > now.getTime()
            ? 'maintenance.scheduled'
            : 'maintenance.enabled';
      } else if (base.active && !nextActive) {
        resolvedAuditAction = 'maintenance.disabled';
      } else {
        resolvedAuditAction = 'maintenance.updated';
      }
    }

    const beforeSnapshot = {
      active: Boolean(base.active),
      scope: base.scope,
      headline: base.headline,
      message: base.message,
      allowedIps: base.allowedIps,
      allowedRoles: base.allowedRoles,
      startsAt: base.startsAt,
      endsAt: base.endsAt
    };

    const updated = await dbp.$transaction(async (tx) => {
      const row = await tx.maintenanceState.upsert({
        where: { id: 'singleton' },
        create: {
          id: 'singleton',
          active: nextActive,
          scope: nextScope,
          headline: nextHeadline,
          message: nextMessage,
          allowedIps: nextAllowedIps,
          allowedRoles: nextAllowedRoles,
          startsAt: nextStartsAt,
          endsAt: nextEndsAt,
          updatedById: actorId
        },
        update: {
          active: nextActive,
          scope: nextScope,
          headline: nextHeadline,
          message: nextMessage,
          allowedIps: nextAllowedIps,
          allowedRoles: nextAllowedRoles,
          startsAt: nextStartsAt,
          endsAt: nextEndsAt,
          updatedById: actorId
        },
        include: {
          updatedBy: { select: { id: true, email: true, username: true } }
        }
      });

      if (tx.outboxEvent?.create) {
        await tx.outboxEvent.create({
          data: {
            aggregateType: 'MaintenanceState',
            aggregateId: 'singleton',
            eventType: 'platform.maintenance.updated',
            payload: {
              active: row.active,
              scope: row.scope,
              headline: row.headline,
              message: row.message,
              allowedIps: row.allowedIps,
              allowedRoles: row.allowedRoles,
              startsAt: row.startsAt,
              endsAt: row.endsAt,
              action: resolvedAuditAction,
              updatedAt: row.updatedAt
            }
          }
        });
      }

      await recordAdminAction({
        adminId: actorId,
        action: resolvedAuditAction,
        outcome: 'SUCCESS',
        targetType: 'MaintenanceState',
        targetId: 'singleton',
        metadata: {
          before: beforeSnapshot,
          after: {
            active: row.active,
            scope: row.scope,
            headline: row.headline,
            message: row.message,
            allowedIps: row.allowedIps,
            allowedRoles: row.allowedRoles,
            startsAt: row.startsAt,
            endsAt: row.endsAt
          },
          reason: effectiveReason.trim()
        },
        ...auditTelemetry,
        dbp: tx
      });

      return row;
    });

    await this.invalidateCache({ active: updated.active, scope: updated.scope, action: resolvedAuditAction });
    logger.info(
      { active: updated.active, scope: updated.scope, action: resolvedAuditAction, actorId },
      'Maintenance state updated'
    );
    return this.computeEffectiveState(updated, now);
  }

  /**
   * Enables maintenance mode immediately or for a scheduled window.
   */
  static async enableMaintenance({
    scope,
    headline,
    message,
    allowedIps,
    allowedRoles,
    startsAt = null,
    endsAt = null,
    reason,
    actorId,
    auditTelemetry = {},
    now = new Date(),
    dbp = prisma
  }) {
    const startObj = startsAt ? new Date(startsAt) : null;
    const isScheduledFuture = startObj && !Number.isNaN(startObj.getTime()) && startObj.getTime() > now.getTime();
    return this.updateMaintenanceState({
      active: true,
      ...(scope !== undefined ? { scope } : {}),
      ...(headline !== undefined ? { headline } : {}),
      ...(message !== undefined ? { message } : {}),
      ...(allowedIps !== undefined ? { allowedIps } : {}),
      ...(allowedRoles !== undefined ? { allowedRoles } : {}),
      startsAt,
      endsAt,
      reason,
      actorId,
      auditAction: isScheduledFuture ? 'maintenance.scheduled' : 'maintenance.enabled',
      auditTelemetry,
      now,
      dbp
    });
  }

  /**
   * Disables maintenance mode cleanly.
   */
  static async disableMaintenance({
    reason,
    actorId,
    auditTelemetry = {},
    now = new Date(),
    dbp = prisma
  }) {
    return this.updateMaintenanceState({
      active: false,
      startsAt: null,
      endsAt: now,
      reason,
      actorId,
      auditAction: 'maintenance.disabled',
      auditTelemetry,
      now,
      dbp
    });
  }

  /**
   * Safe emergency recovery reset: immediately clears active maintenance state,
   * flushes Redis maintenance cache, and records emergency audit event when actorId is present.
   */
  static async emergencyReset({
    reason = 'Emergency maintenance recovery reset',
    actorId = null,
    auditTelemetry = {},
    now = new Date(),
    dbp = prisma
  } = {}) {
    const updated = await dbp.$transaction(async (tx) => {
      const row = await tx.maintenanceState.upsert({
        where: { id: 'singleton' },
        create: {
          id: 'singleton',
          active: false,
          scope: DEFAULT_MAINTENANCE_STATE.scope,
          headline: DEFAULT_MAINTENANCE_STATE.headline,
          message: DEFAULT_MAINTENANCE_STATE.message,
          allowedIps: [],
          allowedRoles: ['SUPER_ADMIN'],
          startsAt: null,
          endsAt: now,
          ...(actorId ? { updatedById: actorId } : {})
        },
        update: {
          active: false,
          startsAt: null,
          endsAt: now,
          ...(actorId ? { updatedById: actorId } : {})
        }
      });

      if (tx.outboxEvent?.create) {
        await tx.outboxEvent.create({
          data: {
            aggregateType: 'MaintenanceState',
            aggregateId: 'singleton',
            eventType: 'platform.maintenance.updated',
            payload: {
              active: false,
              scope: row.scope,
              action: 'maintenance.emergency_reset',
              updatedAt: row.updatedAt
            }
          }
        });
      }

      if (actorId) {
        await recordAdminAction({
          adminId: actorId,
          action: 'maintenance.emergency_reset',
          outcome: 'SUCCESS',
          targetType: 'MaintenanceState',
          targetId: 'singleton',
          metadata: {
            active: false,
            reason: String(reason || 'Emergency maintenance recovery reset').trim(),
            deactivatedAt: now.toISOString()
          },
          ...auditTelemetry,
          dbp: tx
        });
      }

      return row;
    });

    await this.invalidateCache({ active: false, action: 'EMERGENCY_RESET' });
    logger.warn({ actorId, deactivatedAt: now.toISOString() }, 'Emergency maintenance reset executed');
    return this.computeEffectiveState(updated, now);
  }

  /**
   * Evaluates whether a request should be permitted or blocked under the current maintenance state.
   *
   * Lockout & Governance invariants:
   * 1. `/health`, `/ready`, `/webhooks/*`, `/api/v1/auth/*`, `/api/v1/admin/*`, and `/api/v1/maintenance/*`
   *    are ALWAYS allowed (`EXEMPT_PROTECTED_SURFACE`), preserving authentication and backend RBAC at all times.
   * 2. If maintenance is not effectively active (`INACTIVE`, `SCHEDULED`, or `EXPIRED`), request is allowed.
   * 3. If the route is outside the configured `MaintenanceScope`, request is allowed.
   * 4. If the caller holds `SUPER_ADMIN` or any role in `allowedRoles`, request is allowed (`ADMIN_ROLE_BYPASS`).
   * 5. If the caller IP is in `allowedIps`, request is allowed (`ALLOWED_IP_BYPASS`).
   * 6. Otherwise, returns `{ allowed: false, status: 503, ... }` with the configured user-facing message.
   */
  static async evaluateRequestAccess({
    path = '/',
    ip = null,
    adminRoles = [],
    now = new Date(),
    state = null,
    dbp = prisma
  } = {}) {
    const normalizedPath = String(path || '/').split('?')[0];

    // 1. Check permanently exempt surfaces (Auth, Admin RBAC, Health, Webhooks)
    const isExemptSurface = PROTECTED_EXEMPT_PREFIXES.some(
      (prefix) => normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
    );
    if (isExemptSurface) {
      return {
        allowed: true,
        reason: 'EXEMPT_PROTECTED_SURFACE',
        path: normalizedPath
      };
    }

    // 2. Load effective maintenance state
    const effective = state
      ? this.computeEffectiveState(state, now)
      : await this.getMaintenanceState({ dbp, now });

    if (!effective.effectivelyActive) {
      return {
        allowed: true,
        reason: 'MAINTENANCE_INACTIVE',
        effectiveStatus: effective.effectiveStatus,
        path: normalizedPath
      };
    }

    // 3. Check whether path falls within the active MaintenanceScope
    const restrictedPrefixes = effective.restrictedPrefixes ?? SCOPE_RESTRICTED_PREFIXES.FULL_PLATFORM;
    const isScopeRestricted = restrictedPrefixes.some(
      (prefix) => normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
    );
    if (!isScopeRestricted) {
      return {
        allowed: true,
        reason: 'OUTSIDE_MAINTENANCE_SCOPE',
        scope: effective.scope,
        path: normalizedPath
      };
    }

    // 4. Check administrator role bypass (SUPER_ADMIN is always in allowedRoles)
    const callerRoles = Array.isArray(adminRoles) ? adminRoles : [];
    const allowedRoles = effective.allowedRoles ?? ['SUPER_ADMIN'];
    if (callerRoles.some((r) => allowedRoles.includes(r))) {
      return {
        allowed: true,
        reason: 'ADMIN_ROLE_BYPASS',
        scope: effective.scope,
        path: normalizedPath
      };
    }

    // 5. Check IP allowlist bypass
    const allowedIps = Array.isArray(effective.allowedIps) ? effective.allowedIps : [];
    if (ip && allowedIps.includes(String(ip).trim())) {
      return {
        allowed: true,
        reason: 'ALLOWED_IP_BYPASS',
        scope: effective.scope,
        path: normalizedPath
      };
    }

    // 6. Block player request with user-facing maintenance payload
    return {
      allowed: false,
      status: 503,
      reason: 'MAINTENANCE_ACTIVE',
      scope: effective.scope,
      headline: effective.headline,
      message: effective.message,
      startsAt: effective.startsAt,
      endsAt: effective.endsAt,
      path: normalizedPath
    };
  }

  /**
   * Express middleware that enforces maintenance mode on player routes while
   * preserving authentication (`/api/v1/auth`), admin routes (`/api/v1/admin`),
   * webhooks, and health probes.
   */
  static middleware({ dbp = prisma } = {}) {
    return async (req, res, next) => {
      try {
        const reqPath = req.originalUrl || req.path || '/';
        const decision = await this.evaluateRequestAccess({
          path: reqPath,
          ip: req.ip,
          adminRoles: req.adminRoles || [],
          dbp
        });

        if (decision.allowed) {
          return next();
        }

        return res.status(503).json({
          error: 'MAINTENANCE_MODE',
          scope: decision.scope,
          headline: decision.headline,
          message: decision.message,
          startsAt: decision.startsAt,
          endsAt: decision.endsAt
        });
      } catch (err) {
        // Fail open for availability if maintenance state lookup throws unexpectedly
        logger.warn({ err: err.message }, 'Maintenance middleware evaluation error; allowing request');
        return next();
      }
    };
  }

  /**
   * Retrieves paginated audit history for maintenance mode operations.
   */
  static async getMaintenanceHistory({ page = 1, limit = 20, dbp = prisma } = {}) {
    const skip = (Math.max(1, page) - 1) * Math.max(1, limit);
    const take = Math.min(100, Math.max(1, limit));

    const where = {
      targetType: 'MaintenanceState'
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
      history: rows,
      total,
      page: Math.max(1, page),
      totalPages: Math.ceil(total / take)
    };
  }
}
