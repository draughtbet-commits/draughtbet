import jwt from 'jsonwebtoken';
import prisma from '../utils/db.js';
import { getJwtSecret } from '../utils/jwtEnv.js';

const jwtSecret = getJwtSecret();

export const requireAuth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const payload = jwt.verify(token, jwtSecret);
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, email: true, tier: true, isBanned: true, isAdmin: true }
    });
    // A ban restricts ACTIVITY, not access. Rejecting the token here would lock
    // the user out of their own balance and support path, which is exactly the
    // behaviour the per-action eligibility gate exists to prevent. Banned
    // accounts authenticate normally; money and play are refused downstream by
    // assertEligibleForMoney / the lifecycle and callout gates (403).
    if (!user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    req.sessionId = payload.sessionId ?? null;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};
