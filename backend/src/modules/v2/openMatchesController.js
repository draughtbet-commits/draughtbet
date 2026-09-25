/**
 * Open-match routes: list OPEN listings, create one, fund one on join, and
 * serve the lifecycle snapshot plus ready/cancel on the REST surface.
 */
import { Router } from 'express';
import prisma from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { getIO } from '../../sockets/index.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireIdempotencyKey } from '../../middleware/idempotency.js';
import { requireValidStake } from '../../middleware/tierEnforcement.js';
import { EligibilityService } from '../eligibility/service.js';
import {
  finalizeMatchActivation,
  cancelPreplayMatch,
  MatchNotCancellableError
} from '../../services/gameActivationService.js';
import { NotificationService } from '../notification/service.js';
import {
  createOpenMatch,
  fundOpenMatch,
  listOpenMatches,
  buildLifecycleSnapshot,
  markReady,
  MatchNotFoundError,
  NotParticipantError,
  MatchNotReadyError,
  JoinUnavailableError
} from './lifecycleService.js';

export const openMatchRouter = Router();
const eligibilityService = new EligibilityService();

const RULESETS = new Set(['CLASSIC', 'INTERNATIONAL_10X10']);
const VISIBILITIES = new Set(['PUBLIC', 'PRIVATE', 'ANYONE']);

const errorStatusFor = (err) => {
  switch (err.name) {
    case 'InsufficientFundsError':
      return 402;
    case 'SelfJoinError':
    case 'TierMismatchError':
    case 'NotEligibleError':
      return 400;
    case 'SelfExcludedError':
    case 'TimeoutActiveError':
    case 'AccountRestrictedError':
    case 'EligibilityRequiredError':
    case 'CountryNotAllowedError':
    case 'AgeNotVerifiedError':
    case 'KycRequiredError':
      return 403;
    case 'MatchNotFoundError':
      return 404;
    case 'JoinUnavailableError':
      return 409;
    default:
      return 500;
  }
};

openMatchRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const matches = await listOpenMatches(req.user.id);
    res.json({ data: matches });
  } catch (err) {
    next(err);
  }
});

// Pass legacy single-segment routes through to the match router (mounted
// after this one): historical outcomes belong to the old surface.
openMatchRouter.get('/history', (req, res, next) => next());

// The create body uses `stakeMinor`; the shared stake middleware reads
// `stakeMinorUnits`, so remap first, then validate the remaining terms.
openMatchRouter.post(
  '/',
  requireAuth,
  requireIdempotencyKey({ scope: 'match' }),
  async (req, res, next) => {
    req.body.stakeMinorUnits = req.body.stakeMinor;
    next();
  },
  requireValidStake(true),
  async (req, res, next) => {
    try {
      const { id: userId, tier } = req.user;
      const {
        stakeMinor,
        timeControlSeconds,
        ruleset,
        visibility
      } = req.body;

      if (!Number.isInteger(Number(timeControlSeconds)) || Number(timeControlSeconds) < 1) {
        return res.status(400).json({ error: 'timeControlSeconds must be a positive integer' });
      }
      const normalizedRuleset = (ruleset ?? 'CLASSIC').toString().toUpperCase().replaceAll(' ', '_');
      if (!RULESETS.has(normalizedRuleset)) {
        return res.status(400).json({ error: `Unsupported ruleset: ${ruleset}` });
      }
      const normalizedVisibility = (visibility ?? 'PUBLIC').toString().toUpperCase().replaceAll(' ', '_');
      if (!VISIBILITIES.has(normalizedVisibility)) {
        return res.status(400).json({ error: `Unsupported visibility: ${visibility}` });
      }

      await eligibilityService.canCreateMatch(userId, { stakeMinorUnits: stakeMinor });

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

      const match = await createOpenMatch({
        creatorId: userId,
        tier,
        stakeMinorUnits: Number(stakeMinor),
        timeControlSeconds: Number(timeControlSeconds),
        commissionPercent,
        currency: wallet?.currency ?? 'NGN'
      });

      res.status(201).json({ data: { id: match.id } });
    } catch (err) {
      const status = EligibilityService.statusCode(err);
      if (status !== 500) {
        return res.status(status).json({ error: err.message });
      }
      next(err);
    }
  }
);

openMatchRouter.post('/:id/join', requireAuth, requireIdempotencyKey({ scope: 'match' }), async (req, res, next) => {
  try {
    const { id: userId, tier } = req.user;
    const matchId = req.params.id;

    const match = await fundOpenMatch(userId, matchId, { tier });

    // Activation is best-effort; the recovery sweep finishes or releases it.
    const outbox = await prisma.gameOutbox.findUnique({
      where: { matchId: match.id },
      select: { id: true }
    });
    if (outbox) {
      try {
        await finalizeMatchActivation(outbox.id);
      } catch (actErr) {
        logger.warn({ actErr, matchId: match.id }, 'Join activation pending; recovery sweep will finish it');
      }
    }

    const payload = {
      ...match,
      stakeMinorUnits: match.stakeMinorUnits.toString()
    };
    const io = getIO();
    io.to(`user:${match.playerLightId}`).emit('match_found', payload);
    io.to(`user:${match.playerDarkId}`).emit('match_found', payload);

    try {
      await Promise.all([
        NotificationService.create(
          match.playerDarkId,
          'MATCH_FOUND',
          'Match Found!',
          'An opponent has been found. Your match is starting.',
          `/match/${match.id}`,
          match.id
        ),
        NotificationService.create(
          match.playerLightId,
          'MATCH_FOUND',
          'Match Found!',
          'Your open match was accepted. Head to the room.',
          `/match/${match.id}`,
          match.id
        )
      ]);
    } catch (notifyErr) {
      logger.warn({ notifyErr, matchId: match.id }, 'Join notifications failed');
    }

    res.json({ data: { id: match.id } });
  } catch (err) {
    const status = errorStatusFor(err);
    if (status !== 500) {
      return res.status(status).json({ error: err.message });
    }
    next(err);
  }
});

// REST readiness: writes the same Redis marker as the socket ready path and
// starts the match once both participants are ready; returns the snapshot.
openMatchRouter.post('/:id/ready', requireAuth, requireIdempotencyKey({ scope: 'match' }), async (req, res, next) => {
  try {
    const snapshot = await markReady(prisma, req.params.id, req.user.id);
    res.json({ data: snapshot });
  } catch (err) {
    if (err instanceof MatchNotFoundError) {
      return res.status(404).json({ error: { code: 'MATCH_NOT_FOUND', message: err.message } });
    }
    if (err instanceof NotParticipantError) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: err.message } });
    }
    if (err instanceof MatchNotReadyError) {
      return res.status(409).json({ error: { code: 'MATCH_NOT_READY', message: err.message } });
    }
    next(err);
  }
});

// Pre-play cancellation; payload is the lifecycle snapshot in one envelope.
openMatchRouter.post('/:id/cancel', requireAuth, requireIdempotencyKey({ scope: 'match' }), async (req, res, next) => {
  try {
    const { id: userId } = req.user;
    const matchId = req.params.id;

    // Only a participant may cancel; a challenge's pending invitee has no seat.
    const holder = await prisma.match.findFirst({
      where: {
        id: matchId,
        OR: [{ playerLightId: userId }, { playerDarkId: userId }]
      },
      select: { id: true }
    });
    if (!holder) {
      throw new NotParticipantError('Only a participant can cancel this match');
    }

    const result = await cancelPreplayMatch(matchId);
    await prisma.matchChallenge.updateMany({
      where: { matchId },
      data: { status: 'CANCELLED' }
    });
    const snapshot = await buildLifecycleSnapshot(prisma, matchId, userId);
    res.json({ data: { ...snapshot, ...result } });
  } catch (err) {
    if (err instanceof MatchNotFoundError) {
      return res.status(404).json({ error: { code: 'MATCH_NOT_FOUND', message: err.message } });
    }
    if (err instanceof NotParticipantError) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: err.message } });
    }
    if (err instanceof MatchNotCancellableError) {
      return res.status(409).json({ error: { code: 'MATCH_CANNOT_BE_CANCELLED', message: err.message } });
    }
    next(err);
  }
});

// The player a challenge is directed at may decline it. Only PENDING can be
// declined; accepting goes through the normal join route.
openMatchRouter.post('/:id/decline', requireAuth, requireIdempotencyKey({ scope: 'match' }), async (req, res, next) => {
  try {
    const { id: userId } = req.user;
    const matchId = req.params.id;

    const challenge = await prisma.matchChallenge.findFirst({
      where: { matchId },
      select: { id: true, inviterId: true, inviteeId: true, status: true }
    });
    if (!challenge) {
      throw new MatchNotFoundError('This match has no attached challenge');
    }
    if (challenge.inviteeId !== userId) {
      throw new NotParticipantError('Only the invited player can decline this challenge');
    }
    if (challenge.status !== 'PENDING') {
      throw new JoinUnavailableError('This challenge is no longer pending');
    }

    await cancelPreplayMatch(matchId);
    await prisma.matchChallenge.update({
      where: { id: challenge.id },
      data: { status: 'DECLINED' }
    });

    try {
      const invitee = await prisma.user.findUnique({
        where: { id: challenge.inviteeId },
        select: { username: true, displayName: true }
      });
      const inviteeName = invitee?.displayName ?? invitee?.username ?? 'A player';
      await NotificationService.create(
        challenge.inviterId,
        'MATCH_CHALLENGE_DECLINED',
        'Challenge declined',
        `${inviteeName} declined your challenge`,
        null,
        matchId
      );
    } catch (notifyErr) {
      logger.warn({ notifyErr, matchId }, 'Decline notification failed');
    }

    res.json({ data: { id: matchId, status: 'CANCELLED', declined: true } });
  } catch (err) {
    if (err instanceof MatchNotFoundError) {
      return res.status(404).json({ error: { code: 'MATCH_NOT_FOUND', message: err.message } });
    }
    if (err instanceof NotParticipantError) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: err.message } });
    }
    if (err instanceof JoinUnavailableError) {
      return res.status(409).json({ error: { code: 'MATCH_NOT_AVAILABLE', message: err.message } });
    }
    next(err);
  }
});

openMatchRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const snapshot = await buildLifecycleSnapshot(prisma, req.params.id, req.user.id);
    res.json({ data: snapshot });
  } catch (err) {
    if (err instanceof MatchNotFoundError) {
      return res.status(404).json({ error: { code: 'MATCH_NOT_FOUND', message: err.message } });
    }
    if (err instanceof NotParticipantError) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: err.message } });
    }
    next(err);
  }
});