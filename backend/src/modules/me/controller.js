import express from 'express';
import { z } from 'zod';
import { AuthService } from '../auth/service.js';
import { requireAuth } from '../../middleware/auth.js';
import { EligibilityService } from '../eligibility/service.js';
import {
  registerPushToken,
  listPushTokens,
  revokePushToken,
  PushTokenError
} from './pushTokenService.js';

export const meRouter = express.Router();

const eligibilityService = new EligibilityService();

const eligibilityQuerySchema = z.object({
  action: z.enum(['WITHDRAW', 'DEPOSIT', 'PLAY', 'JOIN', 'CREATE', 'STAKE']),
  amount: z.string().regex(/^\d+$/, 'amount must be a positive integer').refine((s) => BigInt(s) > 0n, 'amount must be positive').optional()
});

const updateProfileSchema = z.object({
  // Only predesigned avatar ids are accepted. No uploads.
  avatar: z.string().trim().min(1).max(64)
});

const pushTokenSchema = z.object({
  token: z.string().trim().min(1).max(4096),
  platform: z.enum(['ios', 'android', 'web']),
  deviceId: z.string().trim().min(1).max(128).optional()
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

meRouter.post('/push-tokens', requireAuth, async (req, res, next) => {
  try {
    const data = pushTokenSchema.parse(req.body ?? {});
    const token = await registerPushToken(req.user.id, data);
    res.status(201).json({ data: token });
  } catch (err) {
    if (err && err.name === 'ZodError') {
      return res.status(400).json({ errors: err.errors || err.issues });
    }
    if (err && err.name === 'PushTokenError') {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

meRouter.get('/push-tokens', requireAuth, async (req, res, next) => {
  try {
    const tokens = await listPushTokens(req.user.id);
    res.json({ data: tokens });
  } catch (err) {
    next(err);
  }
});

meRouter.delete('/push-tokens/:id', requireAuth, async (req, res, next) => {
  try {
    const result = await revokePushToken(req.user.id, req.params.id);
    res.json({ data: result });
  } catch (err) {
    if (err && err.name === 'PushTokenError') {
      return res.status(404).json({ error: err.message });
    }
    next(err);
  }
});

// Contract §4: GET /me/eligibility — read-only explanation of the gate for an
// action. It only explains (never decides), so a 403/422 body still returns the
// gate report rather than a thrown error.
meRouter.get('/eligibility', requireAuth, async (req, res, next) => {
  try {
    const query = Object.fromEntries(
      Object.entries(req.query || {}).map(([k, v]) => [k, typeof v === 'string' ? v : String(v)])
    );
    const parsed = eligibilityQuerySchema.parse(query);
    const report = await eligibilityService.explain(req.user.id, {
      action: parsed.action,
      amountMinorUnits: parsed.amount
    });
    res.status(report.allowed ? 200 : report.status).json(report);
  } catch (err) {
    if (err && err.name === 'ZodError') {
      return res.status(400).json({ errors: err.errors || err.issues });
    }
    next(err);
  }
});