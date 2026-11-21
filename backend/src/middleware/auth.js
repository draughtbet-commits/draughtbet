import jwt from 'jsonwebtoken';
import prisma from '../utils/db.js';
import { getJwtSecret } from '../utils/jwtEnv.js';
import { extractAccessFromCookie } from '../utils/authCookies.js';

const jwtSecret = getJwtSecret();

export const requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const bearerToken =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : null;
    const cookieToken = !bearerToken ? extractAccessFromCookie(req) : null;
    const token = bearerToken || cookieToken;

    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const payload = jwt.verify(token, jwtSecret);
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        id: true,
        email: true,
        username: true,
        fullName: true,
        tier: true,
        isBanned: true,
        isAdmin: true
      }
    });
    if (!user || user.isBanned) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    req.user = user;
    req.authTransport = bearerToken ? 'bearer' : 'cookie';
    req.auth = {
      userId: payload.userId,
      sessionFamily: typeof payload.sessionFamily === 'string' ? payload.sessionFamily : null,
      mfaVerified: payload.mfaVerified === true,
      mfaVerifiedAt: typeof payload.mfaVerifiedAt === 'number' ? payload.mfaVerifiedAt : null,
      exp: typeof payload.exp === 'number' ? payload.exp : null
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};
