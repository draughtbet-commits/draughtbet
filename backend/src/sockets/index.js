import { Server } from 'socket.io';
import logger from '../utils/logger.js';
import { socketAuthMiddleware } from './middleware.js';
import { handleDisconnect, handleJoinMatch } from './disconnectHandler.js';
import { handleClockSync, handleMoveAttempt, handleMoveSubmit, handleResign, handlePlayerReady, handleDrawOffer, handleDrawRespond, handleChatSend } from './gameManager.js';
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
      // The socket has already joined its user room above, so `live` includes
      // this very connection; excluding it keeps the cap at MAX rather than
      // silently allowing MAX + 1.
      const live = await io.in(`user:${socket.user.userId}`).fetchSockets();
      const others = Math.max(live.length - 1, 0);
      if (others >= MAX_SOCKETS_PER_USER) {
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

    socket.on('player.ready', guardSocketHandler(socket, handlePlayerReady, 'player.ready'));

    socket.on('draw.offer', guardSocketHandler(socket, handleDrawOffer, 'draw.offer'));
    socket.on('draw.respond', guardSocketHandler(socket, handleDrawRespond, 'draw.respond'));

    socket.on('match.resign', guardSocketHandler(socket, handleResign, 'match.resign'));
    socket.on('resign', guardSocketHandler(socket, handleResign, 'resign'));

    socket.on('match.join', guardSocketHandler(socket, handleJoinMatch, 'match.join'));
    socket.on('join_match', guardSocketHandler(socket, handleJoinMatch, 'join_match'));

    socket.on('clock.sync', guardSocketHandler(socket, handleClockSync, 'clock.sync'));

    // In-match chat (real-time only). Registered only under the V2 name: the
    // feature does not exist in the legacy client, so there is no legacy alias.
    socket.on('chat.send', guardSocketHandler(socket, handleChatSend, 'chat.send'));
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
      // Coded so the client can refresh and reconnect deliberately, instead of
      // waiting for the *next* handshake to fail and having to diagnose that.
      //
      // Disconnecting in the same tick as the emit can close the transport
      // before the packet is flushed, so a mid-game expiry would drop the
      // client with no idea why: it sees a bare disconnect, falls into the 60s
      // grace, and loses on time without ever being told to refresh. Give the
      // event a tick to drain first, then drop the connection.
      socket.emit('auth_expired', {
        code: 'TOKEN_EXPIRED',
        message: 'Session expired'
      });
      setTimeout(() => socket.disconnect?.(true), 0);
      return;
    }
    if (eventName) {
      const budget = await consumeBudget({ userId: socket.user?.userId, eventName });
      if (!budget.allowed) {
        // A throttle is not a broken connection, and the client must be able to
        // tell them apart: lumping them together as `error` makes a transient
        // budget rejection look like a dropped session, which pushes the client
        // into reconnecting and re-sending the very event that was throttled.
        // Log the event name so a flood is diagnosable instead of anonymous.
        logger.warn(
          { userId: socket.user?.userId, eventName, socketId: socket.id },
          'Socket event budget exceeded'
        );
        socket.emit('rate_limited', {
          code: 'RATE_LIMITED',
          event: eventName,
          retryAfterMs: budget.retryAfterMs,
          message: 'Too many events, please slow down'
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
