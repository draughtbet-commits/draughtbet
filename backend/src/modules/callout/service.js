import prisma from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { getIO } from '../../sockets/index.js';
import { createMatchWithStakes } from '../../services/matchService.js';
import { finalizeMatchActivation } from '../../services/gameActivationService.js';
import { NotificationService } from '../notification/service.js';

export class CalloutUnavailableError extends Error {
  constructor(message = 'Callout is no longer available') {
    super(message);
    this.name = 'CalloutUnavailableError';
  }
}

export class SelfAcceptError extends Error {
  constructor(message = 'Cannot accept your own callout') {
    super(message);
    this.name = 'SelfAcceptError';
  }
}

export class NotEligibleError extends Error {
  constructor(message = 'Player is not eligible to play') {
    super(message);
    this.name = 'NotEligibleError';
  }
}

export class TierMismatchError extends Error {
  constructor(message = 'Acceptor tier does not match the callout tier') {
    super(message);
    this.name = 'TierMismatchError';
  }
}

export class ActiveMatchError extends Error {
  constructor(message = 'Player already has an active match') {
    super(message);
    this.name = 'ActiveMatchError';
  }
}

export const createCallout = async (challengerId, tier, stakeMinorUnits) => {
  // Expiry is 15 minutes by default, per typical realtime app lifecycles (can be tuned)
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  
  const callout = await prisma.callout.create({
    data: {
      challengerId,
      tier,
      stakeMinorUnits: BigInt(stakeMinorUnits),
      status: 'OPEN',
      expiresAt
    },
    include: {
      challenger: { select: { displayName: true } }
    }
  });

  // Explicitly select fields for JSON-safe payload (avoids BigInt serialization crashes)
  const payload = {
    id: callout.id,
    challengerId: callout.challengerId,
    challenger: callout.challenger,
    stakeMinorUnits: callout.stakeMinorUnits.toString(),
    tier: callout.tier,
    status: callout.status,
    expiresAt: callout.expiresAt,
    createdAt: callout.createdAt,
  };

  logger.info({ calloutId: callout.id, challengerId, tier }, 'Callout created');

  // Broadcast to all online users. 
  // In a more complex setup we could use tier-specific socket rooms for broadcasting.
  // For now, we broadcast to everyone, and the client ignores if tier doesn't match.
  const io = getIO();
  io.emit('callout_created', payload);

  // Send notifications to eligible users asynchronously
  prisma.user.findMany({
    where: { tier, id: { not: challengerId } },
    select: { id: true }
  }).then(users => {
    return Promise.all(users.map(u => 
      NotificationService.create(
        u.id, 
        'CALLOUT_RECEIVED', 
        'New Challenge Available', 
        `A new callout is available in the ${tier} tier.`, 
        '/tier-select'
      )
    ));
  }).catch(err => logger.error({ err }, 'Failed to send CALLOUT_RECEIVED notifications'));

  return payload;
};

export const getOpenCallouts = async (userId) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { tier: true }
  });

  if (!user) throw new Error('User not found');

  const callouts = await prisma.callout.findMany({
    where: {
      status: 'OPEN',
      tier: user.tier,
      expiresAt: { gt: new Date() },
      challengerId: { not: userId }
    },
    orderBy: { createdAt: 'desc' },
    include: {
      challenger: { select: { displayName: true } }
    }
  });

  // Explicitly select fields to avoid BigInt serialization issues
  return callouts.map(c => ({
    id: c.id,
    challengerId: c.challengerId,
    challenger: c.challenger,
    stakeMinorUnits: c.stakeMinorUnits.toString(),
    tier: c.tier,
    status: c.status,
    expiresAt: c.expiresAt,
    createdAt: c.createdAt,
  }));
};

export const acceptCallout = async (userId, calloutId) => {
  // Claim, validate and fund in ONE transaction. A row lock serializes
  // concurrent accepts of the same callout; policy checks (self-accept, tier,
  // ban, active-match) and the wallet reservation run before the callout is
  // marked ACCEPTED, so a failed accept rolls everything back and the callout
  // stays open for the next eligible player.
  const { callout, match } = await prisma.$transaction(async (tx) => {
    // 1. Claim the callout row for this transaction
    const rows = await tx.$queryRaw`
      SELECT * FROM "Callout" WHERE id = ${calloutId} FOR UPDATE
    `;
    const callout = rows[0];
    if (!callout || callout.status !== 'OPEN' || callout.expiresAt <= new Date()) {
      throw new CalloutUnavailableError();
    }

    // 2. Reject self-accept: the challenger cannot accept their own callout.
    //    This is what previously let a user debit the same wallet twice and
    //    create a match against themselves.
    if (callout.challengerId === userId) {
      throw new SelfAcceptError();
    }

    // 3. Validate both users' authoritative eligibility (tier, ban)
    const [challenger, acceptor] = await Promise.all([
      tx.user.findUnique({
        where: { id: callout.challengerId },
        select: { id: true, tier: true, isBanned: true }
      }),
      tx.user.findUnique({
        where: { id: userId },
        select: { id: true, tier: true, isBanned: true }
      })
    ]);

    if (!challenger || challenger.isBanned) {
      throw new NotEligibleError('Challenger is not eligible to play');
    }
    if (!acceptor || acceptor.isBanned) {
      throw new NotEligibleError('Acceptor is not eligible to play');
    }
    if (acceptor.tier !== callout.tier) {
      throw new TierMismatchError();
    }

    // 4. Active-match eligibility for both players
    for (const playerId of [callout.challengerId, userId]) {
      const active = await tx.match.findFirst({
        where: {
          status: 'ACTIVE',
          OR: [{ playerLightId: playerId }, { playerDarkId: playerId }]
        },
        select: { id: true }
      });
      if (active) throw new ActiveMatchError();
    }

    // 5. Reserve stakes + create Match atomically on the same tx
    const match = await createMatchWithStakes(
      tx,
      callout.challengerId,
      userId,
      callout.stakeMinorUnits,
      callout.tier
    );

    // 6. Mark the callout accepted while still holding the lock
    await tx.$executeRaw`
      UPDATE "Callout"
      SET status = 'ACCEPTED', "acceptedBy" = ${userId}
      WHERE id = ${calloutId}
    `;

    return { callout, match };
  });

  // 7. Durable activation. The outbox record was written in the same
  //    transaction that funded the match; activating is best-effort here. If
  //    Redis is not ready the recovery sweep finishes it (or releases the
  //    match), and a crash in between cannot orphan the reserved stakes.
  const outbox = await prisma.gameOutbox.findUnique({
    where: { matchId: match.id },
    select: { id: true }
  });
  if (outbox) {
    try {
      await finalizeMatchActivation(outbox.id);
    } catch (actErr) {
      logger.warn({ actErr, matchId: match.id }, 'Activation pending; the recovery sweep will finish it');
    }
  }

  // Convert BigInt for socket/HTTP payload
  const matchPayload = {
    ...match,
    stakeMinorUnits: match.stakeMinorUnits.toString()
  };

  // 8. Notify both players that the match has been found and they should join the room
  const io = getIO();
  io.to(`user:${callout.challengerId}`).emit('match_found', matchPayload);
  io.to(`user:${userId}`).emit('match_found', matchPayload);

  // Trigger CALLOUT_ACCEPTED notification to challenger
  await NotificationService.create(
    callout.challengerId,
    'CALLOUT_ACCEPTED',
    'Challenge Accepted!',
    'Your callout has been accepted. The match is starting.',
    `/match/${match.id}`
  );

  logger.info({ calloutId, matchId: match.id, p1: callout.challengerId, p2: userId }, 'Callout accepted, match created');

  return matchPayload;
};
