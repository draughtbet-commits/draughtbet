import express from 'express';
import { PERMISSIONS } from '../rbac/permissions.js';
import { requirePermission } from '../rbac/service.js';
import { auditFromRequest } from '../audit/service.js';
import { parsePagination } from '../../utils/pagination.js';
import {
  listRiskEvents,
  listRiskCases,
  updateRiskCaseStatus,
  RISK_CASE_STATUS_LIST,
  RiskCaseNotFoundError
} from './service.js';

// Risk review surface (RISK_COMPLIANCE / SUPER_ADMIN). Mounted inside the
// admin router AFTER requireAuth + requireAdminMfa + the idempotency gate, so
// auth, MFA and POST idempotency are inherited from the parent.

export const riskRouter = express.Router();

riskRouter.get('/risk-events', requirePermission(PERMISSIONS.RISK_REVIEW), async (req, res, next) => {
  try {
    const parsed = parsePagination(req.query);
    if (!parsed.ok) return res.status(400).json({ error: 'Invalid pagination params' });
    const { page, limit } = parsed.data;
    const { type, severity, userId } = req.query;
    const data = await listRiskEvents({
      page,
      limit,
      type: typeof type === 'string' ? type : null,
      severity: typeof severity === 'string' ? severity : null,
      userId: typeof userId === 'string' ? userId : null
    });
    res.json(data);
  } catch (error) {
    next(error);
  }
});

riskRouter.get('/risk-cases', requirePermission(PERMISSIONS.RISK_REVIEW), async (req, res, next) => {
  try {
    const parsed = parsePagination(req.query);
    if (!parsed.ok) return res.status(400).json({ error: 'Invalid pagination params' });
    const { page, limit } = parsed.data;
    const { status } = req.query;
    const data = await listRiskCases({
      page,
      limit,
      status: typeof status === 'string' ? status : null
    });
    res.json(data);
  } catch (error) {
    next(error);
  }
});

riskRouter.post('/risk-cases/:id/status', requirePermission(PERMISSIONS.RISK_REVIEW), async (req, res, next) => {
  try {
    const { status, assignedTo } = req.body ?? {};
    if (!RISK_CASE_STATUS_LIST.includes(status)) {
      return res.status(400).json({ error: 'Invalid risk case status' });
    }
    const updated = await updateRiskCaseStatus(req.params.id, {
      status,
      assignedTo: typeof assignedTo === 'string' ? assignedTo : null
    });
    await auditFromRequest(req, 'risk-case.status', {
      targetType: 'risk-case',
      targetId: req.params.id,
      metadata: { status, assignedTo: typeof assignedTo === 'string' ? assignedTo : null }
    });
    res.json({ riskCase: updated });
  } catch (error) {
    if (error instanceof RiskCaseNotFoundError || error?.name === 'RiskCaseNotFoundError') {
      return res.status(404).json({ error: error.message });
    }
    next(error);
  }
});