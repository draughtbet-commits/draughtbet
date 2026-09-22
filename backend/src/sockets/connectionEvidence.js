import prisma from '../utils/db.js';
import logger from '../utils/logger.js';

// Durable connection/dispute evidence. Best-effort: evidence must never block
// gameplay or a disconnect, so failures are logged and swallowed.
export const recordConnectionEvent = async ({ matchId, userId, state, socket = null }) => {
  try {
    await prisma.matchConnectionEvent.create({
      data: {
        matchId,
        userId,
        state,
        ipAddress: socket?.handshake?.address ?? null,
        userAgent: socket?.handshake?.headers?.['user-agent'] ?? null
      }
    });
  } catch (err) {
    logger.warn({ err, matchId, userId, state }, 'Failed to persist connection event');
  }
};

export const recordGameEvent = async ({ matchId, playerId = null, type, payload = null }) => {
  try {
    await prisma.gameEvent.create({ data: { matchId, playerId, type, payload } });
  } catch (err) {
    logger.warn({ err, matchId, type }, 'Failed to persist game event');
  }
};
