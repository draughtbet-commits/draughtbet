import { Server } from 'socket.io';
import logger from '../../utils/logger.js';
import { socketAuthMiddleware } from './middleware.js';
import { joinQueue, leaveQueue } from './matchmaking.js';

let io;

export const initSocketServer = (httpServer) => {
  const corsOrigin = process.env.ADMIN_CORS_ORIGIN;
  if (!corsOrigin) {
    throw new Error('FATAL: ADMIN_CORS_ORIGIN is missing. Refusing to start Socket.IO with open CORS.');
  }

  io = new Server(httpServer, {
    cors: {
      origin: corsOrigin,
      methods: ['GET', 'POST']
    }
  });

  // Apply authentication middleware
  io.use(socketAuthMiddleware);

  io.on('connection', (socket) => {
    logger.info({ userId: socket.user.userId, socketId: socket.id }, 'User connected to Socket.IO');

    socket.on('disconnect', () => {
      logger.info({ userId: socket.user.userId, socketId: socket.id }, 'User disconnected from Socket.IO');
      // TODO: Handle disconnection (e.g. 60s reconnect timer)
      // Note: We might want to remove them from matchmaking queues here if they were waiting
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

    // TODO: Register game logic handlers (make_move, resign) here
  });

  return io;
};

export const getIO = () => {
  if (!io) {
    throw new Error('Socket.IO has not been initialized. Call initSocketServer first.');
  }
  return io;
};
