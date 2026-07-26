import { Server } from 'socket.io';
import logger from '../utils/logger.js';
import { socketAuthMiddleware } from './middleware.js';
import { handleDisconnect, handleJoinMatch } from './disconnectHandler.js';
import { handleMoveAttempt, handleResign } from './gameManager.js';

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
    }
  });

  // Apply authentication middleware
  io.use(socketAuthMiddleware);

  io.on('connection', (socket) => {
    logger.info({ userId: socket.user.userId, socketId: socket.id }, 'User connected to Socket.IO');

    // Every authenticated socket joins a personal room so server-side code
    // (e.g. settlement.js wallet_updated) can target a specific user
    // regardless of which match room they're in.
    socket.join(`user:${socket.user.userId}`);

    socket.on('disconnect', () => {
      logger.info({ userId: socket.user.userId, socketId: socket.id }, 'User disconnected from Socket.IO');
      handleDisconnect(socket);
    });

    socket.on('move_attempt', async (payload) => {
      await handleMoveAttempt(socket, payload);
    });

    socket.on('resign', async (payload) => {
      await handleResign(socket, payload);
    });

    socket.on('join_match', async (payload) => {
      await handleJoinMatch(socket, payload);
    });
  });

  return io;
};

export const getIO = () => {
  if (!io) {
    throw new Error('Socket.IO has not been initialized. Call initSocketServer first.');
  }
  return io;
};
