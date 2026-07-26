import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireValidStake } from '../../middleware/tierEnforcement.js';
import redis from '../../utils/redis.js';
import logger from '../../utils/logger.js';

export const matchmakingRouter = express.Router();

// Join the matchmaking queue
matchmakingRouter.post('/join', requireAuth, requireValidStake(false), async (req, res, next) => {
  try {
    const { userId, tier } = req.user;
    const { stakeMinorUnits } = req.body;
    
    // We bucket users strictly by tier and exact stake preset amount.
    // E.g. queue:AMATEUR:50000
    const queueKey = `queue:${tier}:${stakeMinorUnits}`;
    
    // Add to sorted set, scored by timestamp to prioritize those waiting longest
    await redis.zadd(queueKey, Date.now(), userId);
    
    logger.info({ userId, tier, stakeMinorUnits }, 'User joined matchmaking queue');
    
    res.status(200).json({ status: 'queued', queueKey });
  } catch (err) {
    next(err);
  }
});

// Leave the matchmaking queue
matchmakingRouter.post('/leave', requireAuth, async (req, res, next) => {
  try {
    const { userId, tier } = req.user;
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
