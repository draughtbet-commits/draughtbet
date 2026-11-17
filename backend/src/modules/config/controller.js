import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { requirePermission, getUserRoles } from '../rbac/service.js';
import {
  ConfigService,
  ConfigValidationError,
  DraftNotFoundError,
  ImmutableVersionError,
  ChecksumIntegrityError
} from './service.js';
import { CONFIG_DOMAINS } from './schema.js';

export const configRouter = express.Router();

// All configuration management routes require authenticated admin sessions
configRouter.use(requireAuth);

const getAuditTelemetry = (req) => ({
  ip: req.ip,
  userAgent: req.get('user-agent') || null,
  requestId: req.id || null
});

const handleConfigError = (err, res, next) => {
  if (err instanceof ConfigValidationError) {
    return res.status(err.status).json({
      error: err.message,
      issues: err.issues
    });
  }
  if (err instanceof DraftNotFoundError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err instanceof ImmutableVersionError || err instanceof ChecksumIntegrityError) {
    return res.status(err.status).json({ error: err.message });
  }
  return next(err);
};

/**
 * Validates that an administrator holds permission to propose changes
 * across all detected modified domains. Server-authoritative check.
 */
const checkDomainPermissions = (roles, modifiedDomains) => {
  if (roles.includes('SUPER_ADMIN')) {
    return { allowed: true, unauthorizedDomains: [] };
  }

  const unauthorizedDomains = [];

  for (const domain of modifiedDomains) {
    switch (domain) {
      case CONFIG_DOMAINS.FINANCIAL:
      case CONFIG_DOMAINS.TIERS:
        if (!roles.includes('FINANCE')) {
          unauthorizedDomains.push(domain);
        }
        break;
      case CONFIG_DOMAINS.GAME:
      case CONFIG_DOMAINS.MATCHMAKING:
        if (!roles.includes('GAME_OPERATIONS')) {
          unauthorizedDomains.push(domain);
        }
        break;
      case CONFIG_DOMAINS.SAFER_PLAY:
      case CONFIG_DOMAINS.KYC:
        if (!roles.includes('RISK_COMPLIANCE')) {
          unauthorizedDomains.push(domain);
        }
        break;
      case CONFIG_DOMAINS.PLATFORM:
        if (!roles.some((r) => ['FINANCE', 'GAME_OPERATIONS', 'RISK_COMPLIANCE'].includes(r))) {
          unauthorizedDomains.push(domain);
        }
        break;
      default:
        unauthorizedDomains.push(domain);
    }
  }

  return {
    allowed: unauthorizedDomains.length === 0,
    unauthorizedDomains
  };
};

/**
 * Base propose guard verifying caller has at least one administrative configuration role.
 */
const requireProposePermission = async (req, res, next) => {
  try {
    const assignments = await getUserRoles(req.user.id);
    if (!assignments || assignments.length === 0) {
      return res.status(403).json({ error: 'Account does not have admin privileges' });
    }
    const roles = assignments.map((a) => a.role?.name || a.role);
    req.adminRoles = roles;

    if (
      roles.includes('SUPER_ADMIN') ||
      roles.includes('FINANCE') ||
      roles.includes('GAME_OPERATIONS') ||
      roles.includes('RISK_COMPLIANCE')
    ) {
      return next();
    }

    return res.status(403).json({ error: 'Insufficient permission to propose configuration changes' });
  } catch (err) {
    return next(err);
  }
};

/**
 * GET /api/v1/admin/config/active
 * Returns the currently active configuration version and payload.
 */
configRouter.get(
  '/active',
  requirePermission(PERMISSIONS.CONFIG_READ),
  async (req, res, next) => {
    try {
      const active = await ConfigService.getActiveConfig();
      res.status(200).json({
        config: active
      });
    } catch (err) {
      handleConfigError(err, res, next);
    }
  }
);

/**
 * GET /api/v1/admin/config/versions
 * Returns paginated configuration version history.
 */
configRouter.get(
  '/versions',
  requirePermission(PERMISSIONS.CONFIG_READ),
  async (req, res, next) => {
    try {
      const page = req.query.page ? Number.parseInt(req.query.page, 10) : 1;
      const limit = req.query.limit ? Number.parseInt(req.query.limit, 10) : 20;
      const status = req.query.status || null;

      const history = await ConfigService.getVersionHistory({ page, limit, status });
      res.status(200).json(history);
    } catch (err) {
      handleConfigError(err, res, next);
    }
  }
);

/**
 * GET /api/v1/admin/config/versions/:version
 * Returns details and full payload of a specific version number.
 */
configRouter.get(
  '/versions/:version',
  requirePermission(PERMISSIONS.CONFIG_READ),
  async (req, res, next) => {
    try {
      const version = await ConfigService.getVersionByNumber(req.params.version);
      if (!version) {
        return res.status(404).json({ error: `Configuration version ${req.params.version} not found` });
      }
      res.status(200).json({ version });
    } catch (err) {
      handleConfigError(err, res, next);
    }
  }
);

/**
 * POST /api/v1/admin/config/drafts/validate
 * Dry-run validation of a candidate configuration payload without persisting.
 */
configRouter.post(
  '/drafts/validate',
  requirePermission(PERMISSIONS.CONFIG_READ),
  async (req, res, next) => {
    try {
      const { payload, baseVersion } = req.body || {};
      if (!payload) {
        return res.status(400).json({ error: 'Configuration payload is required' });
      }

      const result = await ConfigService.validateDraftPayload({ payload, baseVersion });
      res.status(200).json(result);
    } catch (err) {
      handleConfigError(err, res, next);
    }
  }
);

/**
 * POST /api/v1/admin/config/drafts
 * Initiates a new configuration draft. Server-side multi-domain authorization.
 */
configRouter.post(
  '/drafts',
  requireProposePermission,
  async (req, res, next) => {
    try {
      const { changeReason, baseVersion, payload, effectiveFrom } = req.body || {};

      // Dry run domain check if candidate payload provided
      if (payload) {
        const valResult = await ConfigService.validateDraftPayload({ payload, baseVersion });
        if (valResult.valid) {
          const { allowed, unauthorizedDomains } = checkDomainPermissions(
            req.adminRoles,
            valResult.modifiedDomains
          );
          if (!allowed) {
            return res.status(403).json({
              error: `Insufficient permission to propose changes for domain(s): ${unauthorizedDomains.join(', ')}`,
              unauthorizedDomains
            });
          }
        }
      }

      const draft = await ConfigService.createDraft({
        authorId: req.user.id,
        changeReason,
        baseVersion,
        payload,
        effectiveFrom,
        auditTelemetry: getAuditTelemetry(req)
      });

      res.status(201).json({ draft });
    } catch (err) {
      handleConfigError(err, res, next);
    }
  }
);

/**
 * PATCH /api/v1/admin/config/drafts/:id
 * Updates an un-submitted configuration draft. Enforces domain permissions and immutability.
 */
configRouter.patch(
  '/drafts/:id',
  requireProposePermission,
  async (req, res, next) => {
    try {
      const { payload, changeReason, effectiveFrom } = req.body || {};

      if (payload) {
        const valResult = await ConfigService.validateDraftPayload({ payload });
        if (valResult.valid) {
          const { allowed, unauthorizedDomains } = checkDomainPermissions(
            req.adminRoles,
            valResult.modifiedDomains
          );
          if (!allowed) {
            return res.status(403).json({
              error: `Insufficient permission to propose changes for domain(s): ${unauthorizedDomains.join(', ')}`,
              unauthorizedDomains
            });
          }
        }
      }

      const draft = await ConfigService.updateDraft({
        draftId: req.params.id,
        authorId: req.user.id,
        payload,
        changeReason,
        effectiveFrom,
        auditTelemetry: getAuditTelemetry(req)
      });

      res.status(200).json({ draft });
    } catch (err) {
      handleConfigError(err, res, next);
    }
  }
);

/**
 * DELETE /api/v1/admin/config/drafts/:id
 * Discards an un-submitted configuration draft.
 */
configRouter.delete(
  '/drafts/:id',
  requireProposePermission,
  async (req, res, next) => {
    try {
      const result = await ConfigService.deleteDraft({
        draftId: req.params.id,
        actorId: req.user.id,
        auditTelemetry: getAuditTelemetry(req)
      });

      res.status(200).json(result);
    } catch (err) {
      handleConfigError(err, res, next);
    }
  }
);
