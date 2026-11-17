import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { requirePermission } from '../rbac/service.js';
import {
  NotificationTemplateService,
  TemplateValidationError,
  TemplateNotFoundError,
  TemplateConflictError
} from './service.js';

export const notificationTemplateRouter = express.Router();

notificationTemplateRouter.use(requireAuth);

const getAuditTelemetry = (req) => ({
  ip: req.ip,
  userAgent: req.get('user-agent') || null,
  requestId: req.id || null
});

const handleTemplateError = (err, res, next) => {
  if (err instanceof TemplateValidationError) {
    return res.status(err.status || 400).json({
      error: err.message,
      issues: err.issues,
      ...(err.missingVariables && err.missingVariables.length > 0
        ? { missingVariables: err.missingVariables }
        : {})
    });
  }
  if (err instanceof TemplateNotFoundError) {
    return res.status(err.status || 404).json({ error: err.message });
  }
  if (err instanceof TemplateConflictError) {
    return res.status(err.status || 409).json({ error: err.message });
  }
  return next(err);
};

/**
 * GET /api/v1/admin/notification-templates/channels
 * Returns honest runtime capabilities for all notification channels.
 */
notificationTemplateRouter.get(
  '/channels',
  requirePermission(PERMISSIONS.CONFIG_READ),
  async (_req, res) => {
    res.status(200).json({
      channels: NotificationTemplateService.getChannelCapabilities()
    });
  }
);

/**
 * GET /api/v1/admin/notification-templates
 * Lists notification templates with optional filtering by category, channel, isActive, and search.
 */
notificationTemplateRouter.get(
  '/',
  requirePermission(PERMISSIONS.CONFIG_READ),
  async (req, res, next) => {
    try {
      const { category, channel, isActive, search } = req.query;
      let parsedActive = undefined;
      if (isActive === 'true') parsedActive = true;
      if (isActive === 'false') parsedActive = false;

      const templates = await NotificationTemplateService.listTemplates({
        category: typeof category === 'string' ? category : null,
        channel: typeof channel === 'string' ? channel : null,
        isActive: parsedActive,
        search: typeof search === 'string' ? search : null
      });

      res.status(200).json({
        templates,
        count: templates.length,
        channelCapabilities: NotificationTemplateService.getChannelCapabilities()
      });
    } catch (err) {
      handleTemplateError(err, res, next);
    }
  }
);

/**
 * POST /api/v1/admin/notification-templates/preview
 * Dry-run preview and variable validation of a draft or candidate template payload.
 */
notificationTemplateRouter.post(
  '/preview',
  requirePermission(PERMISSIONS.CONFIG_READ),
  async (req, res, next) => {
    try {
      const { code, title, bodyTemplate, variables, channels, sampleValues } = req.body || {};
      const preview = NotificationTemplateService.renderTemplate({
        code,
        title,
        bodyTemplate,
        variables,
        channels,
        sampleValues: sampleValues ?? {}
      });

      res.status(200).json({ preview });
    } catch (err) {
      handleTemplateError(err, res, next);
    }
  }
);

/**
 * GET /api/v1/admin/notification-templates/:codeOrId
 * Returns details of a single notification template by code or ID.
 */
notificationTemplateRouter.get(
  '/:codeOrId',
  requirePermission(PERMISSIONS.CONFIG_READ),
  async (req, res, next) => {
    try {
      const template = await NotificationTemplateService.getTemplate(req.params.codeOrId);
      if (!template) {
        return res.status(404).json({
          error: `Notification template '${req.params.codeOrId}' not found`
        });
      }
      res.status(200).json({ template });
    } catch (err) {
      handleTemplateError(err, res, next);
    }
  }
);

/**
 * GET /api/v1/admin/notification-templates/:codeOrId/history
 * Returns paginated version and audit history for a notification template.
 */
notificationTemplateRouter.get(
  '/:codeOrId/history',
  requirePermission(PERMISSIONS.CONFIG_READ),
  async (req, res, next) => {
    try {
      const page = req.query.page ? Number.parseInt(req.query.page, 10) : 1;
      const limit = req.query.limit ? Number.parseInt(req.query.limit, 10) : 20;

      const history = await NotificationTemplateService.getTemplateHistory(req.params.codeOrId, {
        page,
        limit
      });
      res.status(200).json(history);
    } catch (err) {
      handleTemplateError(err, res, next);
    }
  }
);

/**
 * POST /api/v1/admin/notification-templates/:codeOrId/preview
 * Previews a saved notification template with provided sampleValues.
 */
notificationTemplateRouter.post(
  '/:codeOrId/preview',
  requirePermission(PERMISSIONS.CONFIG_READ),
  async (req, res, next) => {
    try {
      const { sampleValues, variables } = req.body || {};
      const preview = await NotificationTemplateService.previewSavedTemplate(req.params.codeOrId, {
        sampleValues: sampleValues ?? variables ?? {}
      });
      res.status(200).json({ preview });
    } catch (err) {
      handleTemplateError(err, res, next);
    }
  }
);

/**
 * POST /api/v1/admin/notification-templates
 * Creates a new notification template at version 1 (TEMPLATES_MANAGE).
 */
notificationTemplateRouter.post(
  '/',
  requirePermission(PERMISSIONS.TEMPLATES_MANAGE),
  async (req, res, next) => {
    try {
      const {
        code,
        title,
        bodyTemplate,
        category,
        channels,
        variables,
        isActive,
        changeReason,
        reason
      } = req.body || {};

      const template = await NotificationTemplateService.createTemplate({
        code,
        title,
        bodyTemplate,
        category,
        channels,
        variables,
        isActive,
        changeReason: changeReason ?? reason,
        actorId: req.user.id,
        auditTelemetry: getAuditTelemetry(req)
      });

      res.status(201).json({ template });
    } catch (err) {
      handleTemplateError(err, res, next);
    }
  }
);

/**
 * PATCH /api/v1/admin/notification-templates/:codeOrId
 * Updates a notification template, increments version, and records audit snapshot (TEMPLATES_MANAGE).
 */
notificationTemplateRouter.patch(
  '/:codeOrId',
  requirePermission(PERMISSIONS.TEMPLATES_MANAGE),
  async (req, res, next) => {
    try {
      const { changeReason, reason, ...updates } = req.body || {};
      const template = await NotificationTemplateService.updateTemplate({
        codeOrId: req.params.codeOrId,
        updates,
        changeReason: changeReason ?? reason,
        actorId: req.user.id,
        auditTelemetry: getAuditTelemetry(req)
      });

      res.status(200).json({ template });
    } catch (err) {
      handleTemplateError(err, res, next);
    }
  }
);
