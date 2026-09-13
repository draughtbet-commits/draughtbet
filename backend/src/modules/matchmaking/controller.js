import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireValidStake } from '../../middleware/tierEnforcement.js';
import { assertEligibleForMoney } from '../../services/eligibilityService.js';
import prisma from '../../utils/db.js';
import redis from '../../utils/redis.js';
import logger from '../../utils/logger.js';

export const matchmakingRouter = express.Router();

// Join the matchmaking queue
matchmakingRouter.post('/join', requireAuth, requireValidStake(false), async (req, res, next) => {
  try {
    const { id: userId, tier } = req.user;
    const { stakeMinorUnits } = req.body;

    // Eligibility is enforced here so ineligible users never reach a queue,
    // and again inside debitStakes when the worker matches the pair.
    await assertEligibleForMoney(prisma, userId);
    
    // We bucket users strictly by tier and exact stake preset amount.
    // E.g. queue:AMATEUR:50000
    const queueKey = `queue:${tier}:${stakeMinorUnits}`;
    
    // Add to sorted set, scored by timestamp to prioritize those waiting longest
    await redis.zadd(queueKey, Date.now(), userId);
    
    logger.info({ userId, tier, stakeMinorUnits }, 'User joined matchmaking queue');
    
    res.status(200).json({ status: 'queued', queueKey });
  } catch (err) {
    if (['EligibilityRequiredError', 'CountryNotAllowedError', 'AgeNotVerifiedError', 'KycRequiredError'].includes(err.name)) {
      return res.status(403).json({ error: err.message });
    }
    next(err);
  }
});

// Leave the matchmaking queue
matchmakingRouter.post('/leave', requireAuth, async (req, res, next) => {
  try {
    const { id: userId, tier } = req.user;
    const { stakeMinorUnits } = req.body;

    if (!stakeMinorUnits) {
      return res.status(400).json({ error: 'stakeMinorUnits is required' });
    }
    
    const queueKey = `queue:${tier}:${stakeMinorUnits}`;
    
    const removed = await redis.zrem(queueKey, userId);
    
    if (removed) {
      logger.info({ userId, tier, stakeMinorUnits }, 'User left matchmaking queue');
    }
    
    res.status(200).json({ status: 'dequeued' });
  } catch (err) {
    next(err);
  }
});
