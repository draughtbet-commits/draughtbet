import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import {
  getProfile,
  setDepositLimit,
  setStakeLimit,
  startTimeout,
  extendSelfExclusion
} from './service.js';

export const saferPlayRouter = express.Router();

saferPlayRouter.get('/profile', requireAuth, async (req, res, next) => {
  try {
    const { id: userId } = req.user;
    const profile = await getProfile(userId);
    if (!profile) return res.json({ profile: null });
    res.json({ profile });
  } catch (error) {
    next(error);
  }
});

saferPlayRouter.put('/deposit-limit', requireAuth, async (req, res, next) => {
  try {
    const { id: userId } = req.user;
    const { amountMinorUnits } = req.body ?? {};
    const profile = await setDepositLimit(userId, amountMinorUnits);
    res.json({ profile });
  } catch (error) {
    if (error.name === 'InvalidAmountError') {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

saferPlayRouter.put('/stake-limit', requireAuth, async (req, res, next) => {
  try {
    const { id: userId } = req.user;
    const { amountMinorUnits } = req.body ?? {};
    const profile = await setStakeLimit(userId, amountMinorUnits);
    res.json({ profile });
  } catch (error) {
    if (error.name === 'InvalidAmountError') {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

saferPlayRouter.post('/timeout', requireAuth, async (req, res, next) => {
  try {
    const { id: userId } = req.user;
    const { minutes } = req.body ?? {};
    const profile = await startTimeout(userId, minutes);
    res.status(201).json({ profile });
  } catch (error) {
    switch (error.name) {
      case 'InvalidTimeoutError':
        return res.status(400).json({ error: error.message });
      case 'TimeoutShrinkError':
        return res.status(409).json({ error: error.message });
      default:
        return next(error);
    }
  }
});

saferPlayRouter.post('/self-exclusion', requireAuth, async (req, res, next) => {
  try {
    const { id: userId } = req.user;
    const { until } = req.body ?? {};
    const profile = await extendSelfExclusion(userId, until);
    res.status(201).json({ profile });
  } catch (error) {
    switch (error.name) {
      case 'InvalidSelfExclusionError':
        return res.status(400).json({ error: error.message });
      case 'SelfExclusionShrinkError':
        return res.status(409).json({ error: error.message });
      default:
        return next(error);
    }
  }
});