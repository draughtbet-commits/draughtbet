import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { requirePermission } from '../rbac/service.js';
import {
  MaintenanceService,
  MaintenanceValidationError,
  MaintenanceLockoutProtectionError,
  MaintenanceConflictError
} from './service.js';

export const maintenanceRouter = express.Router();

maintenanceRouter.use(requireAuth);

const getAuditTelemetry = (req) => ({
  ip: req.ip,
  userAgent: req.get('user-agent') || null,
  requestId: req.id || null
});

const handleMaintenanceError = (err, res, next) => {
  if (err instanceof MaintenanceValidationError) {
    return res.status(err.status || 400).json({
      error: err.message,
      issues: err.issues
    });
  }
  if (err instanceof MaintenanceLockoutProtectionError) {
    return res.status(err.status || 403).json({
      error: err.message
    });
  }
  if (err instanceof MaintenanceConflictError) {
    return res.status(err.status || 409).json({
      error: err.message
    });
  }
  return next(err);
};

/**
 * GET /api/v1/admin/maintenance
 * Returns current maintenance mode configuration and computed effective status.
 */
maintenanceRouter.get(
  '/',
  requirePermission(PERMISSIONS.MAINTENANCE_READ),
  async (_req, res, next) => {
    try {
      const maintenance = await MaintenanceService.getMaintenanceState();
      res.status(200).json({ maintenance });
    } catch (err) {
      handleMaintenanceError(err, res, next);
    }
  }
);

/**
 * GET /api/v1/admin/maintenance/history
 * Returns paginated audit history of maintenance mode operations.
 */
maintenanceRouter.get(
  '/history',
  requirePermission(PERMISSIONS.MAINTENANCE_READ),
  async (req, res, next) => {
    try {
      const page = req.query.page ? Number.parseInt(req.query.page, 10) : 1;
      const limit = req.query.limit ? Number.parseInt(req.query.limit, 10) : 20;

      const history = await MaintenanceService.getMaintenanceHistory({ page, limit });
      res.status(200).json(history);
    } catch (err) {
      handleMaintenanceError(err, res, next);
    }
  }
);

/**
 * POST /api/v1/admin/maintenance/evaluate
 * Evaluates whether a simulated request path/IP/role would be allowed or blocked.
 */
maintenanceRouter.post(
  '/evaluate',
  requirePermission(PERMISSIONS.MAINTENANCE_READ),
  async (req, res, next) => {
    try {
      const { path, ip, adminRoles } = req.body || {};
      const decision = await MaintenanceService.evaluateRequestAccess({
        path: path || '/',
        ip: ip ?? null,
        adminRoles: Array.isArray(adminRoles) ? adminRoles : []
      });
      res.status(200).json({ decision });
    } catch (err) {
      handleMaintenanceError(err, res, next);
    }
  }
);

/**
 * PATCH /api/v1/admin/maintenance (and PUT /api/v1/admin/maintenance)
 * Updates maintenance mode configuration, scope, window, or user-facing message.
 */
const updateHandler = async (req, res, next) => {
  try {
    const {
      active,
      scope,
      headline,
      message,
      allowedIps,
      allowedRoles,
      startsAt,
      endsAt,
      reason,
      changeReason
    } = req.body || {};

    const maintenance = await MaintenanceService.updateMaintenanceState({
      active,
      scope,
      headline,
      message,
      allowedIps,
      allowedRoles,
      startsAt,
      endsAt,
      reason: reason ?? changeReason,
      actorId: req.user.id,
      auditTelemetry: getAuditTelemetry(req)
    });

    res.status(200).json({ maintenance });
  } catch (err) {
    handleMaintenanceError(err, res, next);
  }
};

maintenanceRouter.patch(
  '/',
  requirePermission(PERMISSIONS.MAINTENANCE_MANAGE),
  updateHandler
);

maintenanceRouter.put(
  '/',
  requirePermission(PERMISSIONS.MAINTENANCE_MANAGE),
  updateHandler
);

/**
 * POST /api/v1/admin/maintenance/enable
 * Enables maintenance mode immediately or for a scheduled window.
 */
maintenanceRouter.post(
  '/enable',
  requirePermission(PERMISSIONS.MAINTENANCE_MANAGE),
  async (req, res, next) => {
    try {
      const {
        scope,
        headline,
        message,
        allowedIps,
        allowedRoles,
        startsAt,
        endsAt,
        reason,
        changeReason
      } = req.body || {};

      const maintenance = await MaintenanceService.enableMaintenance({
        scope,
        headline,
        message,
        allowedIps,
        allowedRoles,
        startsAt,
        endsAt,
        reason: reason ?? changeReason,
        actorId: req.user.id,
        auditTelemetry: getAuditTelemetry(req)
      });

      res.status(200).json({ maintenance });
    } catch (err) {
      handleMaintenanceError(err, res, next);
    }
  }
);

/**
 * POST /api/v1/admin/maintenance/disable
 * Disables maintenance mode cleanly with mandatory audit reason.
 */
maintenanceRouter.post(
  '/disable',
  requirePermission(PERMISSIONS.MAINTENANCE_MANAGE),
  async (req, res, next) => {
    try {
      const { reason, changeReason } = req.body || {};
      const maintenance = await MaintenanceService.disableMaintenance({
        reason: reason ?? changeReason,
        actorId: req.user.id,
        auditTelemetry: getAuditTelemetry(req)
      });

      res.status(200).json({ maintenance });
    } catch (err) {
      handleMaintenanceError(err, res, next);
    }
  }
);

/**
 * POST /api/v1/admin/maintenance/emergency-reset
 * Emergency recovery endpoint that immediately disables maintenance mode and purges Redis cache.
 */
maintenanceRouter.post(
  '/emergency-reset',
  requirePermission(PERMISSIONS.MAINTENANCE_MANAGE),
  async (req, res, next) => {
    try {
      const { reason, changeReason } = req.body || {};
      const maintenance = await MaintenanceService.emergencyReset({
        reason: reason ?? changeReason ?? 'Emergency maintenance recovery reset',
        actorId: req.user.id,
        auditTelemetry: getAuditTelemetry(req)
      });

      res.status(200).json({
        maintenance,
        recovered: true
      });
    } catch (err) {
      handleMaintenanceError(err, res, next);
    }
  }
);
