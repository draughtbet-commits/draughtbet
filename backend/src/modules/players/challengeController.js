/**
 * Directed player challenges: create one for a specific player and list my
 * pending invites under the players surface.
 */
import { Router } from 'express';
import prisma from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireIdempotencyKey } from '../../middleware/idempotency.js';
import { requireValidStake } from '../../middleware/tierEnforcement.js';
import { NotificationService } from '../notification/service.js';
import { EligibilityService } from '../eligibility/service.js';
import {
  createChallengeMatch,
  matchesJoinedOpenStatuses,
  TierMismatchError
} from '../v2/lifecycleService.js';

export const playerChallengeRouter = Router();

const asInt = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return Number(value);
  return Number(value);
};

const errorStatusFor = (err) => {
  // A cross-tier challenge is a bad request at this surface (historical
  // contract); everything else maps through the central domain table so funds
  // (402) and eligibility (403/422) errors surface accurately instead of 500.
  if (err?.name === 'TierMismatchError') return 400;
  return EligibilityService.statusCode(err);
};

playerChallengeRouter.get('/challenges', requireAuth, async (req, res, next) => {
  try {
    const { id: userId } = req.user;
    const challenges = await prisma.matchChallenge.findMany({
      where: {
        status: 'PENDING',
        OR: [{ inviterId: userId }, { inviteeId: userId }]
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: {
        match: {
          select: {
            timeControlSeconds: true,
            rulesetVersion: true,
            tier: true
          }
        }
      }
    });

    const userIds = challenges.flatMap((c) => [c.inviterId, c.inviteeId]);
    const users = userIds.length
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, username: true, displayName: true, avatar: true, tier: true }
        })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));

    const challengesOut = challenges.map((c) => {
      const opponentId = c.inviterId === userId ? c.inviteeId : c.inviterId;
      const opponent = byId.get(opponentId);
      return {
        id: c.id,
        matchId: c.matchId,
        direction: c.inviterId === userId ? 'sent' : 'received',
        status: c.status,
        stakeMinorUnits: asInt(c.stakeMinorUnits),
        timeControlSeconds: asInt(c.match?.timeControlSeconds),
        ruleset: c.match?.rulesetVersion ? 'INTERNATIONAL_10X10' : 'CLASSIC',
        createdAt: c.createdAt.toISOString(),
        opponent: opponent
          ? {
              id: opponent.id,
              username: opponent.username ?? opponent.displayName ?? 'Player',
              displayName: opponent.displayName,
              avatarId: opponent.avatar ?? 'avatar_01',
              tier: opponent.tier
            }
          : null
      };
    });

    res.json({ data: { challenges: challengesOut } });
  } catch (err) {
    next(err);
  }
});

playerChallengeRouter.post(
  '/:targetId/challenge',
  requireAuth,
  requireIdempotencyKey({ scope: 'challenge' }),
  async (req, res, next) => {
    req.body.stakeMinorUnits = req.body.stakeMinor;
    next();
  },
  requireValidStake(false),
  async (req, res, next) => {
    try {
      const { id: userId, tier } = req.user;
      const { targetId } = req.params;
      const { stakeMinor, timeControlSeconds, ruleset } = req.body;

      if (targetId === userId) {
        return res.status(400).json({ error: 'You cannot challenge yourself' });
      }
      if (!Number.isInteger(Number(timeControlSeconds)) || Number(timeControlSeconds) < 1) {
        return res.status(400).json({ error: 'timeControlSeconds must be a positive integer' });
      }
      const normalizedRuleset = (ruleset ?? 'CLASSIC').toString().toUpperCase().replaceAll(' ', '_');
      if (normalizedRuleset !== 'CLASSIC' && normalizedRuleset !== 'INTERNATIONAL_10X10') {
        return res.status(400).json({ error: `Unsupported ruleset: ${ruleset}` });
      }

      const [target, inviter] = await Promise.all([
        prisma.user.findUnique({
          where: { id: targetId },
          select: { id: true, tier: true, isBanned: true }
        }),
        prisma.user.findUnique({
          where: { id: userId },
          select: { username: true, displayName: true }
        })
      ]);
      if (!target || target.isBanned) {
        return res.status(404).json({ error: 'Player not found' });
      }
      if (target.tier !== tier) {
        throw new TierMismatchError('Only players in your tier can be challenged');
      }

      const [myMatch, theirMatch] = await Promise.all([
        matchesJoinedOpenStatuses(prisma, userId),
        matchesJoinedOpenStatuses(prisma, targetId)
      ]);
      if (myMatch) {
        return res.status(409).json({ error: 'You already have an active match' });
      }
      if (theirMatch) {
        return res.status(409).json({ error: 'This player already has an active match' });
      }

      const duplicate = await prisma.matchChallenge.findFirst({
        where: {
          status: 'PENDING',
          OR: [
            { inviterId: userId, inviteeId: targetId },
            { inviterId: targetId, inviteeId: userId }
          ]
        },
        select: { id: true }
      });
      if (duplicate) {
        return res.status(409).json({ error: 'A pending challenge already exists between you and this player' });
      }

      const settings = await prisma.platformSettings.findUnique({
        where: { id: 'singleton' }
      });
      if (!settings) throw new Error('Platform settings not configured');
      const commissionPercent = settings.commissionPercent;
      if (!Number.isInteger(commissionPercent) || commissionPercent < 0 || commissionPercent > 100) {
        throw new Error(`Invalid commissionPercent snapshot: ${commissionPercent}`);
      }

      const wallet = await prisma.wallet.findUnique({
        where: { userId },
        select: { currency: true }
      });

      const match = await createChallengeMatch({
        creatorId: userId,
        inviteeId: targetId,
        tier,
        stakeMinorUnits: Number(stakeMinor),
        timeControlSeconds: Number(timeControlSeconds),
        commissionPercent,
        currency: wallet?.currency ?? 'NGN'
      });

      const inviterName = inviter?.displayName ?? inviter?.username ?? 'A player';
      try {
        await NotificationService.create(
          targetId,
          'MATCH_CHALLENGE',
          'New Challenge',
          `${inviterName} has challenged you to a match`,
          '/play/challenge',
          match.id
        );
      } catch (notifyErr) {
        logger.warn({ notifyErr, matchId: match.id }, 'Challenge notification failed');
      }

      res.status(201).json({ data: { id: match.id } });
    } catch (err) {
      const status = errorStatusFor(err);
      if (status !== 500) {
        return res.status(status).json({ error: err.message });
      }
      next(err);
    }
  }
);