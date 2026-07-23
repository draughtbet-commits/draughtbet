import jwt from 'jsonwebtoken';
import logger from '../utils/logger.js';

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret && process.env.NODE_ENV !== 'test') {
  throw new Error('FATAL: JWT_SECRET environment variable is missing.');
}
const JWT_SECRET = jwtSecret || 'test_secret';

/**
 * Socket.IO authentication middleware
 * Extracts JWT from `auth.token` or `handshake.headers.authorization`.
 * Rejects unauthorized connections.
 */
export const socketAuthMiddleware = (socket, next) => {
  try {
    // 1. Try to get token from socket.handshake.auth (preferred in Socket.IO v3+)
    let token = socket.handshake.auth?.token;

    // 2. Fallback to authorization header
    if (!token && socket.handshake.headers?.authorization) {
      const authHeader = socket.handshake.headers.authorization;
      if (authHeader.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
      }
    }

    if (!token) {
      return next(new Error('Authentication error: Token missing'));
    }

    // Verify token
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Attach decoded user info to the socket
    socket.user = {
      userId: decoded.userId
    };

    next();
  } catch (err) {
    logger.warn({ err: err.message, socketId: socket.id }, 'Socket authentication failed');
    next(new Error('Authentication error: Invalid or expired token'));
  }
};
