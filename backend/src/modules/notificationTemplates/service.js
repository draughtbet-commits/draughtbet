import prisma from '../../utils/db.js';
import logger from '../../utils/logger.js';
import redis, { isRedisReady } from '../../utils/redis.js';
import { recordAdminAction } from '../audit/service.js';
import {
  CHANNEL_CAPABILITIES,
  SYSTEM_TEMPLATE_REQUIRED_VARIABLES,
  DEFAULT_NOTIFICATION_TEMPLATES,
  CreateNotificationTemplateSchema,
  UpdateNotificationTemplateSchema,
  validateSafeTemplateContent,
  parseTemplatePlaceholders,
  escapeVariableValue,
  FORBIDDEN_VARIABLE_NAMES
} from './schema.js';

export class TemplateValidationError extends Error {
  constructor(message, issues = [], missingVariables = []) {
    super(message);
    this.name = 'TemplateValidationError';
    this.status = 400;
    this.issues = issues;
    this.missingVariables = missingVariables;
  }
}

export class TemplateNotFoundError extends Error {
  constructor(message = 'Notification template not found') {
    super(message);
    this.name = 'TemplateNotFoundError';
    this.status = 404;
  }
}

export class TemplateConflictError extends Error {
  constructor(message = 'Notification template conflict') {
    super(message);
    this.name = 'TemplateConflictError';
    this.status = 409;
  }
}

const TEMPLATE_CACHE_TTL_SECONDS = 300;
const templateCacheKey = (code) => `notification_template:${code}:v2`;

export class NotificationTemplateService {
  /**
   * Returns honest runtime capabilities for all supported notification channels.
   */
  static getChannelCapabilities() {
    return Object.values(CHANNEL_CAPABILITIES);
  }

  /**
   * Enriches a template record with channel capability descriptors and canonical variable requirements.
   */
  static formatTemplate(template) {
    if (!template) return null;
    const channels = Array.isArray(template.channels) ? template.channels : ['IN_APP'];
    return {
      ...template,
      channelDetails: channels.map((ch) => CHANNEL_CAPABILITIES[ch] ?? { channel: ch, implemented: false }),
      systemRequiredVariables: SYSTEM_TEMPLATE_REQUIRED_VARIABLES[template.code] ?? []
    };
  }

  /**
   * Idempotently seeds canonical notification templates.
   */
  static async ensureDefaultTemplates({ systemUserId = null, dbp = prisma } = {}) {
    const seeded = [];
    for (const def of DEFAULT_NOTIFICATION_TEMPLATES) {
      try {
        const row = await dbp.notificationTemplate.upsert({
          where: { code: def.code },
          create: {
            code: def.code,
            title: def.title,
            bodyTemplate: def.bodyTemplate,
            category: def.category,
            channels: def.channels,
            variables: def.variables,
            isActive: def.isActive,
            version: 1,
            ...(systemUserId ? { updatedById: systemUserId } : {})
          },
          update: {}
        });
        seeded.push(this.formatTemplate(row));
      } catch (err) {
        logger.warn({ err, code: def.code }, 'Could not seed default notification template');
      }
    }
    return seeded;
  }

  /**
   * Lists notification templates with optional category, channel, active status, and search filters.
   */
  static async listTemplates({
    category = null,
    channel = null,
    isActive = undefined,
    search = null,
    dbp = prisma
  } = {}) {
    const where = {};

    if (category && typeof category === 'string') {
      where.category = category.trim().toUpperCase();
    }
    if (channel && typeof channel === 'string') {
      where.channels = { has: channel.trim().toUpperCase() };
    }
    if (typeof isActive === 'boolean') {
      where.isActive = isActive;
    }
    if (search && typeof search === 'string' && search.trim() !== '') {
      const term = search.trim();
      where.OR = [
        { code: { contains: term, mode: 'insensitive' } },
        { title: { contains: term, mode: 'insensitive' } },
        { bodyTemplate: { contains: term, mode: 'insensitive' } }
      ];
    }

    const rows = await dbp.notificationTemplate.findMany({
      where,
      orderBy: [{ category: 'asc' }, { code: 'asc' }],
      include: {
        updatedBy: {
          select: { id: true, email: true, username: true }
        }
      }
    });

    return rows.map((row) => this.formatTemplate(row));
  }

  /**
   * Retrieves a notification template by code or ID, using Redis cache-aside with PostgreSQL fallback.
   */
  static async getTemplate(codeOrId, { dbp = prisma, bypassCache = false } = {}) {
    if (!codeOrId || typeof codeOrId !== 'string') {
      throw new TemplateValidationError('Template code or ID is required');
    }

    const trimmed = codeOrId.trim();
    const upperCode = trimmed.toUpperCase();

    if (!bypassCache && dbp === prisma && isRedisReady()) {
      try {
        const cachedStr = await redis.get(templateCacheKey(upperCode));
        if (cachedStr) {
          const cached = JSON.parse(cachedStr);
          if (cached && cached.code === upperCode) {
            return this.formatTemplate(cached);
          }
        }
      } catch (err) {
        logger.warn({ err: err.message, code: upperCode }, 'Redis read error in getTemplate; falling back to PostgreSQL');
      }
    }

    let template = await dbp.notificationTemplate.findUnique({
      where: { code: upperCode },
      include: {
        updatedBy: { select: { id: true, email: true, username: true } }
      }
    });

    if (!template && /^[0-9a-f-]{36}$/i.test(trimmed)) {
      template = await dbp.notificationTemplate.findUnique({
        where: { id: trimmed },
        include: {
          updatedBy: { select: { id: true, email: true, username: true } }
        }
      });
    }

    if (!template) {
      return null;
    }

    if (!bypassCache && dbp === prisma && isRedisReady()) {
      redis.set(templateCacheKey(template.code), JSON.stringify(template), 'EX', TEMPLATE_CACHE_TTL_SECONDS).catch((err) => {
        logger.warn({ err: err.message, code: template.code }, 'Failed to prime Redis notification template cache');
      });
    }

    return this.formatTemplate(template);
  }

  /**
   * Evicts a template from Redis cache and publishes invalidation event.
   */
  static async invalidateCache(code, payload = {}) {
    if (!isRedisReady()) return;
    try {
      if (code) {
        await redis.del(templateCacheKey(code.toUpperCase()));
      }
      await redis.publish(
        'platform:notification_template:invalidated',
        JSON.stringify({ code: code ?? null, timestamp: Date.now(), ...payload })
      );
    } catch (err) {
      logger.warn({ err: err.message, code }, 'Failed to invalidate Redis notification template cache');
    }
  }

  /**
   * Creates a new notification template at version 1.
   */
  static async createTemplate({
    code,
    title,
    bodyTemplate,
    category = 'TRANSACTIONAL',
    channels = ['IN_APP'],
    variables = null,
    isActive = true,
    changeReason = 'Initial notification template creation',
    actorId,
    auditTelemetry = {},
    dbp = prisma
  }) {
    if (!actorId) {
      throw new TemplateValidationError('Actor ID is required to create a notification template');
    }

    // If caller omitted `variables`, infer from placeholders only when explicitly null/undefined,
    // otherwise validate exact match between declared `variables` and placeholders.
    let candidateVariables = variables;
    if (candidateVariables === null || candidateVariables === undefined) {
      const tVars = parseTemplatePlaceholders(title ?? '').variables;
      const bVars = parseTemplatePlaceholders(bodyTemplate ?? '').variables;
      candidateVariables = Array.from(new Set([...tVars, ...bVars]));
    }

    const parsed = CreateNotificationTemplateSchema.safeParse({
      code,
      title,
      bodyTemplate,
      category,
      channels,
      variables: candidateVariables,
      isActive,
      changeReason
    });

    if (!parsed.success) {
      throw new TemplateValidationError('Notification template validation failed', parsed.error.issues);
    }

    const valid = parsed.data;
    const existing = await dbp.notificationTemplate.findUnique({
      where: { code: valid.code }
    });
    if (existing) {
      throw new TemplateConflictError(`Notification template with code '${valid.code}' already exists`);
    }

    const created = await dbp.$transaction(async (tx) => {
      const row = await tx.notificationTemplate.create({
        data: {
          code: valid.code,
          title: valid.title,
          bodyTemplate: valid.bodyTemplate,
          category: valid.category,
          channels: valid.channels,
          variables: valid.variables,
          isActive: valid.isActive,
          version: 1,
          updatedById: actorId
        },
        include: {
          updatedBy: { select: { id: true, email: true, username: true } }
        }
      });

      if (tx.outboxEvent?.create) {
        await tx.outboxEvent.create({
          data: {
            aggregateType: 'NotificationTemplate',
            aggregateId: row.id,
            eventType: 'platform.notification_template.updated',
            payload: {
              id: row.id,
              code: row.code,
              version: row.version,
              isActive: row.isActive,
              channels: row.channels,
              action: 'CREATED',
              updatedAt: row.updatedAt
            }
          }
        });
      }

      await recordAdminAction({
        adminId: actorId,
        action: 'notification_template.created',
        outcome: 'SUCCESS',
        targetType: 'NotificationTemplate',
        targetId: row.id,
        metadata: {
          code: row.code,
          version: row.version,
          category: row.category,
          channels: row.channels,
          variables: row.variables,
          isActive: row.isActive,
          snapshot: {
            title: row.title,
            bodyTemplate: row.bodyTemplate,
            category: row.category,
            channels: row.channels,
            variables: row.variables,
            isActive: row.isActive
          },
          changeReason: valid.changeReason ?? 'Initial notification template creation'
        },
        ...auditTelemetry,
        dbp: tx
      });

      return row;
    });

    await this.invalidateCache(created.code, { version: created.version, action: 'CREATED' });
    logger.info({ templateId: created.id, code: created.code, version: created.version, actorId }, 'Notification template created');
    return this.formatTemplate(created);
  }

  /**
   * Updates an existing notification template, incrementing its version number and recording audit history.
   */
  static async updateTemplate({
    codeOrId,
    updates = {},
    changeReason = null,
    actorId,
    auditTelemetry = {},
    dbp = prisma
  }) {
    if (!actorId) {
      throw new TemplateValidationError('Actor ID is required to update a notification template');
    }

    const existing = await this.getTemplate(codeOrId, { dbp, bypassCache: true });
    if (!existing) {
      throw new TemplateNotFoundError(`Notification template '${codeOrId}' not found`);
    }

    const payloadToValidate = {
      ...updates,
      ...(changeReason !== null && changeReason !== undefined ? { changeReason } : {})
    };

    const partialParse = UpdateNotificationTemplateSchema.safeParse(payloadToValidate);
    if (!partialParse.success) {
      throw new TemplateValidationError(
        'Notification template update validation failed',
        partialParse.error.issues
      );
    }

    const mergedCandidate = {
      code: existing.code,
      title: updates.title !== undefined ? updates.title : existing.title,
      bodyTemplate: updates.bodyTemplate !== undefined ? updates.bodyTemplate : existing.bodyTemplate,
      category: updates.category !== undefined ? updates.category : existing.category,
      channels: updates.channels !== undefined ? updates.channels : existing.channels,
      variables: updates.variables !== undefined ? updates.variables : existing.variables,
      isActive: updates.isActive !== undefined ? updates.isActive : existing.isActive,
      ...(partialParse.data.changeReason ? { changeReason: partialParse.data.changeReason } : {})
    };

    const fullParse = CreateNotificationTemplateSchema.safeParse(mergedCandidate);
    if (!fullParse.success) {
      throw new TemplateValidationError(
        'Updated notification template failed integrity validation',
        fullParse.error.issues
      );
    }

    const valid = fullParse.data;
    const nextVersion = (existing.version ?? 1) + 1;

    const beforeSnapshot = {
      version: existing.version,
      title: existing.title,
      bodyTemplate: existing.bodyTemplate,
      category: existing.category,
      channels: existing.channels,
      variables: existing.variables,
      isActive: existing.isActive
    };

    const updated = await dbp.$transaction(async (tx) => {
      const row = await tx.notificationTemplate.update({
        where: { id: existing.id },
        data: {
          title: valid.title,
          bodyTemplate: valid.bodyTemplate,
          category: valid.category,
          channels: valid.channels,
          variables: valid.variables,
          isActive: valid.isActive,
          version: nextVersion,
          updatedById: actorId
        },
        include: {
          updatedBy: { select: { id: true, email: true, username: true } }
        }
      });

      if (tx.outboxEvent?.create) {
        await tx.outboxEvent.create({
          data: {
            aggregateType: 'NotificationTemplate',
            aggregateId: row.id,
            eventType: 'platform.notification_template.updated',
            payload: {
              id: row.id,
              code: row.code,
              version: row.version,
              isActive: row.isActive,
              channels: row.channels,
              action: 'UPDATED',
              updatedAt: row.updatedAt
            }
          }
        });
      }

      await recordAdminAction({
        adminId: actorId,
        action: 'notification_template.updated',
        outcome: 'SUCCESS',
        targetType: 'NotificationTemplate',
        targetId: row.id,
        metadata: {
          code: row.code,
          previousVersion: existing.version,
          version: row.version,
          before: beforeSnapshot,
          after: {
            version: row.version,
            title: row.title,
            bodyTemplate: row.bodyTemplate,
            category: row.category,
            channels: row.channels,
            variables: row.variables,
            isActive: row.isActive
          },
          changeReason: valid.changeReason ?? 'Notification template updated'
        },
        ...auditTelemetry,
        dbp: tx
      });

      return row;
    });

    await this.invalidateCache(updated.code, { version: updated.version, action: 'UPDATED' });
    logger.info({ templateId: updated.id, code: updated.code, version: updated.version, actorId }, 'Notification template updated');
    return this.formatTemplate(updated);
  }

  /**
   * Safely validates and renders a notification template (saved or draft) with sample/runtime values.
   *
   * Security & Integrity guarantees:
   * 1. Rejects templates containing raw HTML, `<script>`, `javascript:`, or predatory language.
   * 2. Rejects malformed placeholders (`{{`, `}}`, nested braces, forbidden variable names).
   * 3. Requires all declared and referenced variables (plus canonical system variables if `code` matches)
   *    to be present in `sampleValues` as non-empty primitive values (`string | number | boolean`).
   * 4. Escapes HTML characters in variable values (`&`, `<`, `>`, `"`, `'`) and performs single-pass
   *    substitution so untrusted values can never inject HTML or trigger secondary `{{...}}` evaluation.
   */
  static renderTemplate({
    code = null,
    title,
    bodyTemplate,
    variables = [],
    channels = ['IN_APP'],
    sampleValues = {},
    version = null
  }) {
    if (typeof title !== 'string' || title.trim().length === 0) {
      throw new TemplateValidationError('Template title is required for rendering');
    }
    if (typeof bodyTemplate !== 'string' || bodyTemplate.trim().length === 0) {
      throw new TemplateValidationError('Template bodyTemplate is required for rendering');
    }
    if (!sampleValues || typeof sampleValues !== 'object' || Array.isArray(sampleValues)) {
      throw new TemplateValidationError('sampleValues must be a key-value object');
    }

    const titleSafety = validateSafeTemplateContent(title);
    const bodySafety = validateSafeTemplateContent(bodyTemplate);
    if (!titleSafety.safe || !bodySafety.safe) {
      const issues = [...titleSafety.issues, ...bodySafety.issues];
      throw new TemplateValidationError(
        `Unsafe template content rejected: ${issues.join('; ')}`,
        issues.map((m) => ({ message: m }))
      );
    }

    const titleParsed = parseTemplatePlaceholders(title);
    const bodyParsed = parseTemplatePlaceholders(bodyTemplate);
    if (!titleParsed.valid || !bodyParsed.valid) {
      const errors = [...titleParsed.errors, ...bodyParsed.errors];
      throw new TemplateValidationError(
        `Malformed template placeholders: ${errors.join('; ')}`,
        errors.map((m) => ({ message: m }))
      );
    }

    const normalizedCode = typeof code === 'string' && code.trim() ? code.trim().toUpperCase() : null;
    const sysRequired = normalizedCode ? SYSTEM_TEMPLATE_REQUIRED_VARIABLES[normalizedCode] ?? [] : [];
    const declaredVars = Array.isArray(variables) ? variables : [];

    // Check for undeclared variables if `variables` list was explicitly provided
    const referencedVars = Array.from(new Set([...titleParsed.variables, ...bodyParsed.variables]));
    if (declaredVars.length > 0) {
      const undeclared = referencedVars.filter((v) => !declaredVars.includes(v));
      if (undeclared.length > 0) {
        throw new TemplateValidationError(
          `Template references undeclared variable(s): ${undeclared.join(', ')}`,
          undeclared.map((v) => ({ path: ['variables'], message: `Undeclared variable: ${v}` }))
        );
      }
    }

    const allRequiredVars = Array.from(
      new Set([...declaredVars, ...referencedVars, ...sysRequired])
    );

    // Check forbidden keys in sampleValues
    for (const key of Object.keys(sampleValues)) {
      if (FORBIDDEN_VARIABLE_NAMES.includes(key)) {
        throw new TemplateValidationError(`Forbidden variable '${key}' supplied in sampleValues`);
      }
    }

    // Validate that every required variable has a valid non-empty primitive value
    const missingVariables = [];
    const invalidTypeVariables = [];

    for (const reqVar of allRequiredVars) {
      if (!Object.prototype.hasOwnProperty.call(sampleValues, reqVar)) {
        missingVariables.push(reqVar);
        continue;
      }
      const val = sampleValues[reqVar];
      if (val === null || val === undefined || (typeof val === 'string' && val.trim() === '')) {
        missingVariables.push(reqVar);
        continue;
      }
      if (typeof val !== 'string' && typeof val !== 'number' && typeof val !== 'boolean' && typeof val !== 'bigint') {
        invalidTypeVariables.push(reqVar);
      }
      if (typeof val === 'number' && !Number.isFinite(val)) {
        invalidTypeVariables.push(reqVar);
      }
    }

    if (missingVariables.length > 0) {
      throw new TemplateValidationError(
        `Missing required template variable(s): ${missingVariables.join(', ')}`,
        missingVariables.map((v) => ({ path: ['sampleValues', v], message: `Required variable '${v}' is missing` })),
        missingVariables
      );
    }

    if (invalidTypeVariables.length > 0) {
      throw new TemplateValidationError(
        `Invalid non-primitive value for template variable(s): ${invalidTypeVariables.join(', ')}`,
        invalidTypeVariables.map((v) => ({ path: ['sampleValues', v], message: `Variable '${v}' must be a string, number, or boolean` }))
      );
    }

    // Single-pass escaped substitution
    const replacePlaceholders = (str) =>
      str.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]{0,63})\s*\}\}/g, (_match, varName) => {
        return escapeVariableValue(sampleValues[varName]);
      });

    const renderedTitle = replacePlaceholders(title);
    const renderedBody = replacePlaceholders(bodyTemplate);

    const normalizedChannels = Array.isArray(channels) && channels.length > 0 ? channels : ['IN_APP'];

    return {
      code: normalizedCode,
      version,
      renderedTitle,
      renderedBody,
      requiredVariables: allRequiredVars,
      usedVariables: referencedVars,
      channels: normalizedChannels,
      channelDetails: normalizedChannels.map(
        (ch) => CHANNEL_CAPABILITIES[ch] ?? { channel: ch, implemented: false }
      )
    };
  }

  /**
   * Previews a saved notification template by code or ID using supplied sample values.
   */
  static async previewSavedTemplate(codeOrId, { sampleValues = {}, dbp = prisma } = {}) {
    const template = await this.getTemplate(codeOrId, { dbp });
    if (!template) {
      throw new TemplateNotFoundError(`Notification template '${codeOrId}' not found`);
    }

    return this.renderTemplate({
      code: template.code,
      title: template.title,
      bodyTemplate: template.bodyTemplate,
      variables: template.variables,
      channels: template.channels,
      sampleValues,
      version: template.version
    });
  }

  /**
   * Retrieves paginated version & audit history for a notification template.
   */
  static async getTemplateHistory(codeOrId, { page = 1, limit = 20, dbp = prisma } = {}) {
    if (!codeOrId || typeof codeOrId !== 'string') {
      throw new TemplateValidationError('Template code or ID is required');
    }

    const template = await this.getTemplate(codeOrId, { dbp });
    const upperCode = template ? template.code : codeOrId.trim().toUpperCase();

    const skip = (Math.max(1, page) - 1) * Math.max(1, limit);
    const take = Math.min(100, Math.max(1, limit));

    const where = template
      ? {
          targetType: 'NotificationTemplate',
          OR: [
            { targetId: template.id },
            { metadata: { path: ['code'], equals: upperCode } }
          ]
        }
      : {
          targetType: 'NotificationTemplate',
          metadata: { path: ['code'], equals: upperCode }
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
      template: template ?? { code: upperCode },
      history: rows,
      total,
      page: Math.max(1, page),
      totalPages: Math.ceil(total / take)
    };
  }
}
