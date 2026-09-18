import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { getKycStatus, startVerification } from './service.js';

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