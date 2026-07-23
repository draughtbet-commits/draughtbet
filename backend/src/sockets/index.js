import { Server } from 'socket.io';
import logger from '../utils/logger.js';
import { socketAuthMiddleware } from './middleware.js';
import { joinQueue, leaveQueue } from './matchmaking.js';
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

    socket.on('disconnect', () => {
      logger.info({ userId: socket.user.userId, socketId: socket.id }, 'User disconnected from Socket.IO');
      handleDisconnect(socket);
    });

    socket.on('join_queue', async ({ stakeTier }) => {
      // Input validation
      if (!stakeTier || typeof stakeTier !== 'string') {
        return socket.emit('error', { message: 'Invalid stakeTier' });
      }
      await joinQueue(socket, socket.user.userId, stakeTier);
    });

    socket.on('leave_queue', async ({ stakeTier }) => {
      if (stakeTier) {
        await leaveQueue(socket.user.userId, stakeTier);
      }
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
