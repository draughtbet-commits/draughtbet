import express from 'express';
import { requirePermission } from '../rbac/service.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { listAdminActions, auditPagination } from './service.js';

export const auditRouter = express.Router();

// Mounted under /admin/audit — requireAuth + requirePermission are applied by
// the parent admin router; this router only enforces its own permission.
auditRouter.get(
  '/logs',
  requirePermission(PERMISSIONS.AUDIT_READ),
  async (req, res, next) => {
    try {
      const filters = auditPagination(req.query);
      if (!filters) {
        return res.status(400).json({ error: 'Invalid pagination or filter params' });
      }
      const data = await listAdminActions(filters);
      res.json(data);
    } catch (error) {
      next(error);
    }
  }
);