import express from 'express';
import crypto from 'crypto';
import { requireAuth } from '../../middleware/auth.js';
import { requireIdempotencyKey } from '../../middleware/idempotency.js';
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

// Search handles for the REST client:
//   POST /api/v1/matchmaking/search       -> { data: { searchId } }
//   DELETE /api/v1/matchmaking/search/:id -> { status: 'cancelled' }
// A search is an opaque handle over the same tier+stake queue bucket the
// legacy worker sweeps. It exists so the client can cancel by id; a cancel
// after a match has formed is a no-op zrem and stays idempotent.
const SEARCH_TTL_SECONDS = 60 * 60;

const remapStakeMinor = (req, res, next) => {
  req.body.stakeMinorUnits = req.body.stakeMinor;
  next();
};

matchmakingRouter.post(
  '/search',
  requireAuth,
  requireIdempotencyKey({ scope: 'matchmaking' }),
  remapStakeMinor,
  requireValidStake(false),
  async (req, res, next) => {
    try {
      const { id: userId, tier } = req.user;
      const { stakeMinor, timeControlSeconds, ruleset } = req.body;

      if (!Number.isInteger(Number(timeControlSeconds)) || Number(timeControlSeconds) < 1) {
        return res.status(400).json({ error: 'timeControlSeconds must be a positive integer' });
      }
      const normalizedRuleset = (ruleset ?? 'CLASSIC').toString().toUpperCase().replaceAll(' ', '_');
      if (!['CLASSIC', 'INTERNATIONAL_10X10'].includes(normalizedRuleset)) {
        return res.status(400).json({ error: `Unsupported ruleset: ${ruleset}` });
      }

      await eligibilityService.canJoinMatch(userId, { stakeMinorUnits: stakeMinor });
      if (await hasPreterminalMatchForPlayers(prisma, [userId])) {
        return res.status(409).json({ error: 'You are already in an active match' });
      }

      const queueKey = `queue:${tier}:${stakeMinor}`;
      const searchId = crypto.randomUUID();
      await Promise.all([
        redis.hset(`search:${searchId}`, {
          userId,
          tier,
          stakeMinorUnits: String(stakeMinor),
          queueKey
        }),
        redis.expire(`search:${searchId}`, SEARCH_TTL_SECONDS),
        redis.zadd(queueKey, Date.now(), userId)
      ]);

      logger.info({ userId, tier, stakeMinor }, 'User started a matchmaking search');
      res.status(200).json({ data: { searchId } });
    } catch (err) {
      const status = EligibilityService.statusCode(err);
      if (status !== 500) {
        return res.status(status).json({ error: err.message });
      }
      next(err);
    }
  }
);

matchmakingRouter.delete('/search/:id', requireAuth, requireIdempotencyKey({ scope: 'matchmaking' }), async (req, res, next) => {
  try {
    const userId = req.user.id;
    const searchKey = `search:${req.params.id}`;
    const meta = await redis.hgetall(searchKey);
    if (meta && meta.userId && meta.userId !== userId) {
      return res.status(403).json({ error: 'Not authorized to cancel this search' });
    }
    if (meta && meta.queueKey) {
      await redis.zrem(meta.queueKey, userId);
      await redis.del(searchKey);
      logger.info({ userId, searchId: req.params.id }, 'User cancelled a matchmaking search');
    }
    res.json({ status: 'cancelled' });
  } catch (err) {
    next(err);
  }
});
