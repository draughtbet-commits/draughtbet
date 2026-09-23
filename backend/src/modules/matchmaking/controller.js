import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireValidStake } from '../../middleware/tierEnforcement.js';
import { EligibilityService } from '../eligibility/service.js';
import { hasPreterminalMatchForPlayers } from '../match/service.js';
import prisma from '../../utils/db.js';
import redis from '../../utils/redis.js';
import logger from '../../utils/logger.js';

export const matchmakingRouter = express.Router();
const eligibilityService = new EligibilityService();

// Join the matchmaking queue
matchmakingRouter.post('/join', requireAuth, requireValidStake(false), async (req, res, next) => {
  try {
    const { id: userId, tier } = req.user;
    const { stakeMinorUnits } = req.body;

    // Server-owned play eligibility: account state, timeout and self-exclusion
    // are enforced here so an ineligible player never reaches a queue, and again
    // at funding time inside the atomic debit transaction.
    await eligibilityService.canJoinMatch(userId, { stakeMinorUnits });

    // A player may only be in one game at a time. Refuse to enqueue anyone
    // already holding a pre-terminal match (DRAFT/OPEN/FUNDED/READY/IN_PLAY,
    // or the legacy ACTIVE). Funding re-checks this atomically too, so the
    // worker can never debit a player who just started a game.
    if (await hasPreterminalMatchForPlayers(prisma, [userId])) {
      return res.status(409).json({ error: 'You are already in an active match' });
    }

    // We bucket users strictly by tier and exact stake preset amount.
    // E.g. queue:AMATEUR:50000
    const queueKey = `queue:${tier}:${stakeMinorUnits}`;
    
    // Add to sorted set, scored by timestamp to prioritize those waiting longest
    await redis.zadd(queueKey, Date.now(), userId);
    
    logger.info({ userId, tier, stakeMinorUnits }, 'User joined matchmaking queue');
    
    res.status(200).json({ status: 'queued', queueKey });
  } catch (err) {
    const status = EligibilityService.statusCode(err);
    if (status !== 500) {
      return res.status(status).json({ error: err.message });
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
