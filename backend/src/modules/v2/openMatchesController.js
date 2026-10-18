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
  resolvePrivateListingId,
  listOpenMatches,
  listActiveMatches,
  buildLifecycleSnapshot,
  markReady,
  MatchNotFoundError,
  NotParticipantError,
  MatchNotReadyError,
  JoinUnavailableError
} from './lifecycleService.js';
import { clearPrePlayState, notifyPrePlayReleased } from '../../sockets/prePlayNotifier.js';

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
    case 'RoomCodeNotFoundError':
      return 404;
    case 'JoinUnavailableError':
    case 'ActiveMatchError':
    case 'MatchNotReadyError':
      return 409;
    default:
      return 500;
  }
};

// Funds the listing for `userId`, fires the activation attempt, and announces
// the match to both players (socket + inbox). Shared by the arena join and the
// private-room join-by-code so both behave identically once seated.
const joinMatchAndAnnounce = async ({ userId, tier, matchId, viaCode = false }) => {
  const match = await fundOpenMatch(
    userId,
    matchId,
    viaCode ? { tier, viaCode: true } : { tier }
  );

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

  return match;
};

openMatchRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const matches = await listOpenMatches(req.user.id);
    res.json({ data: matches });
  } catch (err) {
    next(err);
  }
});

// Legacy single-segment routes (notably GET /history) are handed to the match
// router, mounted after this one. The hand-off has to happen from the /:id
// handler below: a next() at this level would resume at the next layer of THIS
// router, which is /:id itself, so a standalone "pass-through" here is a no-op.

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
        currency: wallet?.currency ?? 'NGN',
        visibility: normalizedVisibility
      });

      // A PRIVATE listing is joined by code, not by id, so the creator needs the
      // code back immediately to share it.
      res.status(201).json({
        data: { id: match.id, visibility: match.visibility, roomCode: match.roomCode ?? null }
      });
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
    const match = await joinMatchAndAnnounce({
      userId,
      tier,
      matchId: req.params.id
    });
    res.json({ data: { id: match.id } });
  } catch (err) {
    const status = errorStatusFor(err);
    if (status !== 500) {
      return res.status(status).json({ error: err.message });
    }
    next(err);
  }
});

// Redeem a private room code. Resolves the code to its listing, then joins and
// announces through the same path as an arena join.
openMatchRouter.post('/join-code', requireAuth, requireIdempotencyKey({ scope: 'match' }), async (req, res, next) => {
  try {
    const { id: userId, tier } = req.user;
    const code = req.body?.code;
    if (typeof code !== 'string' || code.trim() === '') {
      return res.status(400).json({
        error: { code: 'INVALID_ROOM_CODE', message: 'A room code is required' }
      });
    }
    const matchId = await resolvePrivateListingId(code);
    const match = await joinMatchAndAnnounce({ userId, tier, matchId, viaCode: true });
    res.json({ data: { id: match.id } });
  } catch (err) {
    if (err.name === 'RoomCodeNotFoundError') {
      return res.status(404).json({
        error: { code: 'ROOM_NOT_FOUND', message: err.message }
      });
    }
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
      select: { id: true, playerLightId: true, playerDarkId: true }
    });
    if (!holder) {
      throw new NotParticipantError('Only a participant can cancel this match');
    }

    const result = await cancelPreplayMatch(matchId);

    await prisma.matchChallenge.updateMany({
      where: { matchId },
      data: { status: 'CANCELLED' }
    });

    // The canceller gets the snapshot in this response, but the opponent is on a
    // socket and has no request to answer: without this emit they sit in the
    // pre-match room waiting for state that will never arrive. Redis cleanup
    // matters for the same reason from the other direction — a stale
    // activeMatch pointer is what resurrects a cancelled match on cold start.
    //
    // endReason stays the default 'cancelled_pre_play' so the stored record is
    // unchanged; cancelledBy carries the actor for the opponent's copy.
    const playerIds = [holder.playerLightId, holder.playerDarkId];
    await clearPrePlayState(matchId, playerIds);
    notifyPrePlayReleased({
      matchId,
      playerIds,
      reason: 'cancelled_by_opponent',
      status: result.status,
      refunded: result.refunded,
      cancelledBy: userId
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

    // Declining an invite ends the match before play; the inviter must be
    // notified on the socket, and any cached activeMatch pointers cleared.
    const challenger = await prisma.match.findFirst({
      where: { id: matchId },
      select: { playerLightId: true, playerDarkId: true }
    });
    const playerIds = challenger ? [challenger.playerLightId, challenger.playerDarkId] : [];
    await clearPrePlayState(matchId, playerIds);
    notifyPrePlayReleased({
      matchId,
      playerIds,
      reason: 'challenge_declined',
      status: 'CANCELLED',
      refunded: false
    });

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

// ALL pre-start matches the caller holds as participants (OPEN / FUNDED /
// READY), newest first, as lifecycle snapshots. Registered before /:id so the
// literal path is not mistaken for a match id.
openMatchRouter.get('/active', requireAuth, async (req, res, next) => {
  try {
    const matches = await listActiveMatches(req.user.id);
    res.json({ data: matches });
  } catch (err) {
    next(err);
  }
});

openMatchRouter.get('/:id', requireAuth, async (req, res, next) => {
  // GET /history belongs to the legacy match router mounted after this one.
  // This is the last layer of this router, so next() exits to it.
  if (req.params.id === 'history') return next();
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