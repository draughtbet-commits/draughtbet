import { Server } from 'socket.io';
import logger from '../utils/logger.js';
import { socketAuthMiddleware } from './middleware.js';
import { handleDisconnect, handleJoinMatch } from './disconnectHandler.js';
import { handleMoveAttempt, handleMoveSubmit, handleResign } from './gameManager.js';
import { consumeBudget, MAX_SOCKETS_PER_USER } from './budget.js';

let io;

export const initSocketServer = (httpServer) => {
  const corsOrigin = process.env.ADMIN_CORS_ORIGIN;
  if (!corsOrigin && process.env.NODE_ENV === 'production') {
    throw new Error('FATAL: ADMIN_CORS_ORIGIN is missing. Refusing to start Socket.IO with open CORS.');
  }

  const socketCorsOrigin = corsOrigin
    || (process.env.NODE_ENV === 'test' ? true : 'http://localhost:3000');

  io = new Server(httpServer, {
    cors: {
      origin: socketCorsOrigin,
      methods: ['GET', 'POST']
    },
    // Payload budget at the transport level: game events are tiny, so bound the
    // message size well below the 1MiB default to blunt oversized-payload abuse.
    maxHttpBufferSize: 16 * 1024
  });

  // Apply authentication middleware
  io.use(socketAuthMiddleware);

  io.on('connection', async (socket) => {
    logger.info({ userId: socket.user.userId, socketId: socket.id }, 'User connected to Socket.IO');

    // Every authenticated socket joins a personal room so server-side code
    // (e.g. settlement.js wallet_updated) can target a specific user
    // regardless of which match room they're in.
    socket.join(`user:${socket.user.userId}`);

    // Connection quota: bound how many sockets one account can hold at once so
    // a compromised client cannot stack connections and multiply event budgets.
    try {
      const live = await io.in(`user:${socket.user.userId}`).fetchSockets();
      if (live.length > MAX_SOCKETS_PER_USER) {
        socket.emit('error', {
          message: `Connection limit reached (${MAX_SOCKETS_PER_USER})`
        });
        logger.info({ userId: socket.user.userId, socketId: socket.id }, 'Connection quota exceeded, disconnecting');
        socket.disconnect(true);
        return;
      }
    } catch (err) {
      logger.error({ err, userId: socket.user.userId }, 'Connection quota check failed');
    }

    socket.on('disconnect', () => {
      logger.info({ userId: socket.user.userId, socketId: socket.id }, 'User disconnected from Socket.IO');
      handleDisconnect(socket);
    });

    // V2 game protocol. Legacy event names remain registered for the deployed
    // Flutter client during the transition (see sockets/gameProtocol.js).
    socket.on('move.submit', guardSocketHandler(socket, handleMoveSubmit, 'move.submit'));
    socket.on('move_attempt', guardSocketHandler(socket, handleMoveAttempt, 'move_attempt'));

    socket.on('match.resign', guardSocketHandler(socket, handleResign, 'match.resign'));
    socket.on('resign', guardSocketHandler(socket, handleResign, 'resign'));

    socket.on('match.join', guardSocketHandler(socket, handleJoinMatch, 'match.join'));
    socket.on('join_match', guardSocketHandler(socket, handleJoinMatch, 'join_match'));
  });

  return io;
};

export const getIO = () => {
  if (!io) {
    throw new Error('Socket.IO has not been initialized. Call initSocketServer first.');
  }
  return io;
};

/**
 * Shared wrapper so a rejected async handler can never become an unhandled
 * rejection (Node's default behaviour terminates the process). Any error that
 * escapes a handler's own boundaries produces a controlled error reply instead.
 *
 * Also enforces connection lifetime (once the access token that authenticated
 * the socket has expired, further actions are refused and the socket is
 * disconnected) and the per-user/per-event budget, so a burst of socket events
 * is throttled rather than delivered to the game engine.
 */
export const guardSocketHandler = (socket, handler, eventName = null) => async (payload) => {
  try {
    if (socket.user?.tokenExpiresAt && Date.now() > socket.user.tokenExpiresAt) {
      socket.emit('error', { message: 'Session expired' });
      socket.disconnect?.(true);
      return;
    }
    if (eventName) {
      const budget = await consumeBudget({ userId: socket.user?.userId, eventName });
      if (!budget.allowed) {
        socket.emit('error', {
          message: 'Too many events, please slow down',
          retryAfterMs: budget.retryAfterMs
        });
        return;
      }
    }
    await handler(socket, payload);
  } catch (err) {
    logger.error({ err, socketId: socket.id }, 'Socket event handler failed');
    socket.emit('error', { message: 'Internal server error' });
  }
};
