import prisma from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { getIO } from '../../sockets/index.js';
import { debitStakes } from '../../services/matchService.js';
import { initializeGame } from '../../sockets/gameManager.js';

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
  // 1. Atomic Conditional Update
  // This explicitly prevents the double-accept race condition.
  // We execute a raw query since Prisma doesn't have a direct "update where condition" 
  // that guarantees rows affected count without a transaction.
  const result = await prisma.$executeRaw`
    UPDATE "Callout" 
    SET status = 'ACCEPTED', "acceptedBy" = ${userId}
    WHERE id = ${calloutId} AND status = 'OPEN' AND "expiresAt" > NOW()
  `;

  if (result === 0) {
    // Callout was already accepted by someone else, cancelled, or expired
    logger.warn({ calloutId, userId }, 'Attempted to accept unavailable callout');
    return null; 
  }

  // 2. Fetch the newly accepted callout to get challengerId and stake
  const callout = await prisma.callout.findUnique({
    where: { id: calloutId }
  });

  if (!callout) {
    throw new Error(`Callout ${calloutId} not found after successful accept`);
  }

  // 3. Create Match & Debit Wallets atomically using the shared fault-isolated path
  // debitStakes(player1Id, player2Id, stakeMinorUnits, stakeTier)
  let match;
  try {
    match = await debitStakes(
      callout.challengerId, 
      userId, 
      callout.stakeMinorUnits, 
      callout.tier
    );
  } catch (err) {
    // Rollback the callout to OPEN if the debit fails (e.g., insufficient funds)
    logger.warn({ calloutId, err: err.message }, 'Rolling back callout accept due to settlement failure');
    await prisma.$executeRaw`
      UPDATE "Callout" 
      SET status = 'OPEN', "acceptedBy" = NULL
      WHERE id = ${calloutId} 
        AND status = 'ACCEPTED' 
        AND "acceptedBy" = ${userId}
    `;
    throw err;
  }

  // 4. Initialize Redis game state
  // player1 is challenger, player2 is acceptor
  await initializeGame(match.id, callout.challengerId, userId, callout.tier);

  // Convert BigInt for socket/HTTP payload
  const matchPayload = {
    ...match,
    stakeMinorUnits: match.stakeMinorUnits.toString()
  };

  // 5. Notify both players that the match has been found and they should join the room
  const io = getIO();
  io.to(`user:${callout.challengerId}`).emit('match_found', matchPayload);
  io.to(`user:${userId}`).emit('match_found', matchPayload);

  logger.info({ calloutId, matchId: match.id, p1: callout.challengerId, p2: userId }, 'Callout accepted, match created');

  return matchPayload;
};
