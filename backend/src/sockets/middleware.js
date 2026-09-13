import jwt from 'jsonwebtoken';
import prisma from '../utils/db.js';
import logger from '../utils/logger.js';
import { getJwtSecret } from '../utils/jwtEnv.js';

const JWT_SECRET = getJwtSecret();

/**
 * Socket.IO authentication middleware
 * Extracts JWT from `auth.token` or `handshake.headers.authorization`.
 * Verifies the signature AND (S06) re-checks the account in the database so a
 * suspended/banned user cannot authenticate a socket even with a valid,
 * unexpired access token. Records the access-token expiry so the server can
 * enforce connection lifetime (see guardSocketHandler).
 */
export const socketAuthMiddleware = async (socket, next) => {
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

    // 3. Validate the account still exists and is not banned (S06)
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, isBanned: true }
    });
    if (!user || user.isBanned) {
      return next(new Error('Account suspended'));
    }

    // Attach decoded user info to the socket
    socket.user = {
      userId: decoded.userId,
      tokenExpiresAt: decoded.exp ? decoded.exp * 1000 : null
    };

    next();
  } catch (err) {
    logger.warn({ err: err.message, socketId: socket.id }, 'Socket authentication failed');
    next(new Error('Authentication error: Invalid or expired token'));
  }
};