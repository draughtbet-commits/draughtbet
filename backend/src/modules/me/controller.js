import express from 'express';
import { z } from 'zod';
import { AuthService } from '../auth/service.js';
import { requireAuth } from '../../middleware/auth.js';

export const meRouter = express.Router();

const updateProfileSchema = z.object({
  // Only predesigned avatar ids are accepted. No uploads.
  avatar: z.string().trim().min(1).max(64)
});

meRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const profile = await AuthService.getProfile(req.user.id);
    res.json(profile);
  } catch (err) {
    next(err);
  }
});

meRouter.patch('/', requireAuth, async (req, res, next) => {
  try {
    const data = updateProfileSchema.parse(req.body);
    const profile = await AuthService.updateProfile(req.user.id, { avatar: data.avatar });
    res.json(profile);
  } catch (err) {
    if (err && err.name === 'ZodError') {
      return res.status(400).json({ errors: err.errors || err.issues });
    }
    if (err.message === 'User not found') {
      return res.status(404).json({ error: err.message });
    }
    next(err);
  }
});

meRouter.get('/sessions', requireAuth, async (req, res, next) => {
  try {
    const sessions = await AuthService.listSessions(req.user.id, { currentSessionId: req.sessionId });
    res.json({ data: sessions });
  } catch (err) {
    next(err);
  }
});

meRouter.delete('/sessions/:sessionId', requireAuth, async (req, res, next) => {
  try {
    const result = await AuthService.revokeSession(req.user.id, req.params.sessionId, {
      ip: req.ip,
      userAgent: req.get('user-agent')
    });
    res.json({ data: result });
  } catch (err) {
    if (err && err.name === 'VerificationChallengeError') {
      return res.status(err.status ?? 400).json({ error: { code: err.code, message: err.message } });
    }
    next(err);
  }
});