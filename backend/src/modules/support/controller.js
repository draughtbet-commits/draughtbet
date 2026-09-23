import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import {
  openSupportCase,
  listMySupportCases,
  getMySupportCase,
  addUserMessageToSupportCase,
  closeMySupportCase
} from './service.js';

export const supportRouter = express.Router();

supportRouter.post('/cases', requireAuth, async (req, res, next) => {
  try {
    const { id: userId } = req.user;
    const { type, subject, description = null, relatedMatchId = null } = req.body ?? {};
    const result = await openSupportCase(userId, {
      type,
      subject,
      description,
      relatedMatchId
    });
    res.status(201).json(result);
  } catch (error) {
    switch (error.name) {
      case 'SupportCaseError':
        return res.status(400).json({ error: error.message });
      case 'SupportCaseOpenLimitError':
        return res.status(429).json({ error: error.message });
      default:
        return next(error);
    }
  }
});

supportRouter.get('/cases', requireAuth, async (req, res, next) => {
  try {
    const { id: userId } = req.user;
    res.json(await listMySupportCases(userId));
  } catch (error) {
    next(error);
  }
});

supportRouter.get('/cases/:caseId', requireAuth, async (req, res, next) => {
  try {
    const { id: userId } = req.user;
    res.json(await getMySupportCase(userId, req.params.caseId));
  } catch (error) {
    if (error.name === 'SupportCaseNotFoundError') {
      return res.status(404).json({ error: error.message });
    }
    next(error);
  }
});

supportRouter.post('/cases/:caseId/messages', requireAuth, async (req, res, next) => {
  try {
    const { id: userId } = req.user;
    const { message } = req.body ?? {};
    const result = await addUserMessageToSupportCase(userId, req.params.caseId, { message });
    res.status(201).json(result);
  } catch (error) {
    switch (error.name) {
      case 'SupportCaseError':
        return res.status(400).json({ error: error.message });
      case 'SupportCaseNotFoundError':
        return res.status(404).json({ error: error.message });
      case 'SupportCaseClosedError':
        return res.status(409).json({ error: error.message });
      default:
        return next(error);
    }
  }
});

supportRouter.post('/cases/:caseId/close', requireAuth, async (req, res, next) => {
  try {
    const { id: userId } = req.user;
    res.json(await closeMySupportCase(userId, req.params.caseId));
  } catch (error) {
    switch (error.name) {
      case 'SupportCaseNotFoundError':
        return res.status(404).json({ error: error.message });
      case 'SupportCaseClosedError':
        return res.status(409).json({ error: error.message });
      default:
        return next(error);
    }
  }
});
export { supportAdminRouter } from './adminController.js';
