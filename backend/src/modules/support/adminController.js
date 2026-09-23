import express from 'express';
import { requirePermission } from '../rbac/service.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { auditFromRequest } from '../audit/service.js';
import { parsePagination } from '../../utils/pagination.js';
import {
  listSupportCases,
  getSupportCase,
  assignSupportCase,
  transitionSupportCase,
  SupportCaseError,
  SupportCaseNotFoundError,
  SupportCaseClosedError
} from './service.js';

export const supportAdminRouter = express.Router();

supportAdminRouter.get('/support/cases', requirePermission(PERMISSIONS.DISPUTES_MANAGE), async (req, res, next) => {
  try {
    const parsed = parsePagination(req.query);
    if (!parsed.ok) return res.status(400).json({ error: 'Invalid pagination params' });
    const { page, limit } = parsed.data;
    const { status, type } = req.query;
    res.json(await listSupportCases({
      page, limit,
      status: typeof status === 'string' ? status : null,
      type: typeof type === 'string' ? type : null
    }));
  } catch (error) { next(error); }
});

supportAdminRouter.get('/support/cases/:caseId', requirePermission(PERMISSIONS.DISPUTES_MANAGE), async (req, res, next) => {
  try {
    res.json(await getSupportCase(req.params.caseId));
  } catch (error) {
    if (error.name === 'SupportCaseNotFoundError') return res.status(404).json({ error: error.message });
    next(error);
  }
});

supportAdminRouter.post('/support/cases/:caseId/assign', requirePermission(PERMISSIONS.DISPUTES_MANAGE), async (req, res, next) => {
  try {
    const { assignedAdminUserId = null } = req.body ?? {};
    const updated = await assignSupportCase(req.params.caseId, assignedAdminUserId);
    await auditFromRequest(req, 'support.assign', { targetType: 'support-case', targetId: req.params.caseId, metadata: { assignedAdminUserId } });
    res.json(updated);
  } catch (error) {
    if (error.name === 'SupportCaseNotFoundError') return res.status(404).json({ error: error.message });
    next(error);
  }
});

supportAdminRouter.post('/support/cases/:caseId/transition', requirePermission(PERMISSIONS.DISPUTES_MANAGE), async (req, res, next) => {
  try {
    const { status, note = null } = req.body ?? {};
    const updated = await transitionSupportCase(req.params.caseId, { status, note });
    await auditFromRequest(req, 'support.transition', { targetType: 'support-case', targetId: req.params.caseId, metadata: { status } });
    res.json(updated);
  } catch (error) {
    switch (error.name) {
      case 'SupportCaseError': return res.status(400).json({ error: error.message });
      case 'SupportCaseNotFoundError': return res.status(404).json({ error: error.message });
      case 'SupportCaseClosedError': return res.status(409).json({ error: error.message });
      default: next(error);
    }
  }
});

export default supportAdminRouter;
