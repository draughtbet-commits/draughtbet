import express from 'express';
import prisma from '../../utils/db.js';
import { requireAuth } from '../../middleware/auth.js';
import { AuthService } from '../auth/service.js';
import { getIO } from '../../sockets/index.js';
import logger from '../../utils/logger.js';

export const adminRouter = express.Router();

adminRouter.use(requireAuth);

// Only admin accounts may touch account status.
adminRouter.use((req, res, next) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Admin privileges required' });
  }
  next();
});

const REVOCATION_MESSAGES = {
  ban: 'Account suspended',
  unban: 'Account reinstated'
};

async function setStatus(req, res, next, banned) {
  try {
    const targetId = req.params.userId;
    const target = await prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, isBanned: true }
    });
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = await AuthService.setAccountStatus(targetId, banned);

    // Disconnect any live sockets so a banned session stops emitting and
    // stops receiving the account's events (S06). Socket.IO may not be
    // initialized in HTTP-only/test environments; that must not fail the ban.
    if (banned) {
      try {
        getIO().in(`user:${targetId}`).disconnectSockets(true);
      } catch (_) {
        // Socket layer not running; the DB flag + refresh revocation still hold.
      }
      logger.info({ adminId: req.user.id, targetId }, 'User banned');
    } else {
      logger.info({ adminId: req.user.id, targetId }, 'User unbanned');
    }

    res.json({ user, message: REVOCATION_MESSAGES[banned ? 'ban' : 'unban'] });
  } catch (err) {
    next(err);
  }
}

adminRouter.patch('/users/:userId/ban', async (req, res, next) => {
  await setStatus(req, res, next, true);
});

adminRouter.patch('/users/:userId/unban', async (req, res, next) => {
  await setStatus(req, res, next, false);
});