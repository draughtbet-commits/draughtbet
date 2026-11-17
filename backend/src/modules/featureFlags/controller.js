import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { requirePermission } from '../rbac/service.js';
import {
  FeatureFlagService,
  FeatureFlagValidationError,
  FeatureFlagNotFoundError,
  FeatureFlagConflictError,
  ProtectedInvariantError
} from './service.js';

export const featureFlagRouter = express.Router();

featureFlagRouter.use(requireAuth);

const getAuditTelemetry = (req) => ({
  ip: req.ip,
  userAgent: req.get('user-agent') || null,
  requestId: req.id || null
});

const handleFeatureFlagError = (err, res, next) => {
  if (err instanceof FeatureFlagValidationError) {
    return res.status(err.status || 400).json({
      error: err.message,
      issues: err.issues
    });
  }
  if (err instanceof FeatureFlagNotFoundError) {
    return res.status(err.status || 404).json({ error: err.message });
  }
  if (err instanceof ProtectedInvariantError) {
    return res.status(err.status || 403).json({ error: err.message });
  }
  if (err instanceof FeatureFlagConflictError) {
    return res.status(err.status || 409).json({ error: err.message });
  }
  return next(err);
};

/**
 * GET /api/v1/admin/feature-flags
 * Lists all feature flags with admin visibility annotations for the caller's roles.
 */
featureFlagRouter.get(
  '/',
  requirePermission(PERMISSIONS.FLAGS_READ),
  async (req, res, next) => {
    try {
      const { search, enabled, isKillSwitch } = req.query;
      let parsedEnabled = undefined;
      if (enabled === 'true') parsedEnabled = true;
      if (enabled === 'false') parsedEnabled = false;

      let parsedKillSwitch = undefined;
      if (isKillSwitch === 'true') parsedKillSwitch = true;
      if (isKillSwitch === 'false') parsedKillSwitch = false;

      const flags = await FeatureFlagService.listFlags({
        search: typeof search === 'string' ? search : null,
        enabled: parsedEnabled,
        isKillSwitch: parsedKillSwitch,
        adminRoles: req.adminRoles
      });

      res.status(200).json({
        flags,
        count: flags.length
      });
    } catch (err) {
      handleFeatureFlagError(err, res, next);
    }
  }
);

/**
 * GET /api/v1/admin/feature-flags/:key
 * Returns details of a single feature flag by key.
 */
featureFlagRouter.get(
  '/:key',
  requirePermission(PERMISSIONS.FLAGS_READ),
  async (req, res, next) => {
    try {
      const flag = await FeatureFlagService.getFlagByKey(req.params.key, {
        adminRoles: req.adminRoles
      });
      if (!flag) {
        return res.status(404).json({ error: `Feature flag '${req.params.key}' not found` });
      }
      res.status(200).json({ flag });
    } catch (err) {
      handleFeatureFlagError(err, res, next);
    }
  }
);

/**
 * GET /api/v1/admin/feature-flags/:key/history
 * Returns paginated audit trail for a specific feature flag.
 */
featureFlagRouter.get(
  '/:key/history',
  requirePermission(PERMISSIONS.FLAGS_READ),
  async (req, res, next) => {
    try {
      const page = req.query.page ? Number.parseInt(req.query.page, 10) : 1;
      const limit = req.query.limit ? Number.parseInt(req.query.limit, 10) : 20;

      const history = await FeatureFlagService.getFlagHistory(req.params.key, {
        page,
        limit
      });
      res.status(200).json(history);
    } catch (err) {
      handleFeatureFlagError(err, res, next);
    }
  }
);

/**
 * POST /api/v1/admin/feature-flags/:key/evaluate
 * Evaluates a feature flag for a given player/tier/role context (deterministic rollout test).
 */
featureFlagRouter.post(
  '/:key/evaluate',
  requirePermission(PERMISSIONS.FLAGS_READ),
  async (req, res, next) => {
    try {
      const { userId, userTier, adminRoles, defaultValue } = req.body || {};
      const evaluation = await FeatureFlagService.evaluateFlag(req.params.key, {
        userId: userId ?? null,
        userTier: userTier ?? null,
        adminRoles: Array.isArray(adminRoles) ? adminRoles : req.adminRoles,
        defaultValue: Boolean(defaultValue)
      });
      res.status(200).json({ evaluation });
    } catch (err) {
      handleFeatureFlagError(err, res, next);
    }
  }
);

/**
 * POST /api/v1/admin/feature-flags
 * Creates a new feature flag (SUPER_ADMIN / FLAGS_MANAGE).
 */
featureFlagRouter.post(
  '/',
  requirePermission(PERMISSIONS.FLAGS_MANAGE),
  async (req, res, next) => {
    try {
      const {
        key,
        name,
        description,
        enabled,
        rolloutPercentage,
        allowedTiers,
        allowedRoles,
        isKillSwitch,
        metadata,
        changeReason,
        reason
      } = req.body || {};

      const flag = await FeatureFlagService.createFlag({
        key,
        name,
        description,
        enabled,
        rolloutPercentage,
        allowedTiers,
        allowedRoles,
        isKillSwitch,
        metadata,
        changeReason: changeReason ?? reason,
        actorId: req.user.id,
        auditTelemetry: getAuditTelemetry(req)
      });

      res.status(201).json({ flag });
    } catch (err) {
      handleFeatureFlagError(err, res, next);
    }
  }
);

/**
 * PATCH /api/v1/admin/feature-flags/:key
 * Updates a feature flag (SUPER_ADMIN / FLAGS_MANAGE).
 */
featureFlagRouter.patch(
  '/:key',
  requirePermission(PERMISSIONS.FLAGS_MANAGE),
  async (req, res, next) => {
    try {
      const { changeReason, reason, ...updates } = req.body || {};
      const flag = await FeatureFlagService.updateFlag({
        key: req.params.key,
        updates,
        changeReason: changeReason ?? reason,
        actorId: req.user.id,
        auditTelemetry: getAuditTelemetry(req)
      });

      res.status(200).json({ flag });
    } catch (err) {
      handleFeatureFlagError(err, res, next);
    }
  }
);

/**
 * POST /api/v1/admin/feature-flags/:key/toggle
 * Enables or disables a feature flag with mandatory reason (SUPER_ADMIN / FLAGS_MANAGE).
 */
featureFlagRouter.post(
  '/:key/toggle',
  requirePermission(PERMISSIONS.FLAGS_MANAGE),
  async (req, res, next) => {
    try {
      const { enabled, changeReason, reason } = req.body || {};
      const flag = await FeatureFlagService.toggleFlag({
        key: req.params.key,
        enabled,
        changeReason: changeReason ?? reason,
        actorId: req.user.id,
        auditTelemetry: getAuditTelemetry(req)
      });

      res.status(200).json({ flag });
    } catch (err) {
      handleFeatureFlagError(err, res, next);
    }
  }
);

/**
 * POST /api/v1/admin/feature-flags/:key/kill-switch
 * Triggers or resets an operational kill switch (FLAGS_KILLSWITCH: SUPER_ADMIN, RISK_COMPLIANCE, GAME_OPERATIONS).
 */
featureFlagRouter.post(
  '/:key/kill-switch',
  requirePermission(PERMISSIONS.FLAGS_KILLSWITCH),
  async (req, res, next) => {
    try {
      const { enabled = false, reason, changeReason } = req.body || {};
      const flag = await FeatureFlagService.triggerKillSwitch({
        key: req.params.key,
        enabled,
        reason: reason ?? changeReason,
        actorId: req.user.id,
        auditTelemetry: getAuditTelemetry(req)
      });

      res.status(200).json({ flag });
    } catch (err) {
      handleFeatureFlagError(err, res, next);
    }
  }
);

/**
 * DELETE /api/v1/admin/feature-flags/:key
 * Deletes a non-protected feature flag (SUPER_ADMIN / FLAGS_MANAGE).
 */
featureFlagRouter.delete(
  '/:key',
  requirePermission(PERMISSIONS.FLAGS_MANAGE),
  async (req, res, next) => {
    try {
      const { reason, changeReason } = req.body || {};
      const result = await FeatureFlagService.deleteFlag({
        key: req.params.key,
        reason: reason ?? changeReason ?? req.query.reason,
        actorId: req.user.id,
        auditTelemetry: getAuditTelemetry(req)
      });

      res.status(200).json(result);
    } catch (err) {
      handleFeatureFlagError(err, res, next);
    }
  }
);
