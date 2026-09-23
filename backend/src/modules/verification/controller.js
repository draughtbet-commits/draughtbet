import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import {
  getKycStatus,
  startVerification,
  attachDocument,
  listMyDocuments,
  revokeDocument,
  InvalidVerificationTypeError,
  KycDocumentError
} from './service.js';

export const verificationRouter = express.Router();

verificationRouter.post('/start', requireAuth, async (req, res, next) => {
  try {
    const { id: userId } = req.user;
    const { type } = req.body ?? {};
    const result = await startVerification(userId, { type });
    res.status(201).json(result);
  } catch (error) {
    switch (error.name) {
      case 'KycAlreadyVerifiedError':
        return res.status(409).json({ error: error.message });
      case 'KycInProgressError':
        return res.status(409).json({ error: error.message });
      case 'KycRejectedError':
        return res.status(422).json({ error: error.message });
      case 'InvalidVerificationTypeError':
        return res.status(400).json({ error: error.message });
      default:
        return next(error);
    }
  }
});

verificationRouter.get('/status', requireAuth, async (req, res, next) => {
  try {
    const { id: userId } = req.user;
    const status = await getKycStatus(userId);
    res.json(status);
  } catch (error) {
    next(error);
  }
});

verificationRouter.post('/documents', requireAuth, async (req, res, next) => {
  try {
    const { id: userId } = req.user;
    const { documentType, objectKey, mimeType, sizeBytes, sha256 } = req.body ?? {};
    const document = await attachDocument(userId, { documentType, objectKey, mimeType, sizeBytes, sha256 });
    res.status(201).json({ document });
  } catch (error) {
    if (error.name === 'InvalidVerificationTypeError') return res.status(400).json({ error: error.message });
    if (error.name === 'KycDocumentError') return res.status(409).json({ error: error.message });
    next(error);
  }
});

verificationRouter.get('/documents', requireAuth, async (req, res, next) => {
  try {
    const { id: userId } = req.user;
    res.json({ documents: await listMyDocuments(userId) });
  } catch (error) {
    next(error);
  }
});

verificationRouter.delete('/documents/:id', requireAuth, async (req, res, next) => {
  try {
    const { id: userId } = req.user;
    const result = await revokeDocument(userId, req.params.id);
    res.json(result);
  } catch (error) {
    if (error.name === 'KycDocumentError') return res.status(404).json({ error: error.message });
    next(error);
  }
});