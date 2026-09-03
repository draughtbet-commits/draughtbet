import jwt from 'jsonwebtoken';
import prisma from '../utils/db.js';

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret && process.env.NODE_ENV !== 'test') {
  throw new Error('FATAL: JWT_SECRET environment variable is missing.');
}

export const requireAuth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const payload = jwt.verify(token, jwtSecret || 'test_secret');
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, email: true, tier: true, isBanned: true }
    });
    if (!user || user.isBanned) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};
