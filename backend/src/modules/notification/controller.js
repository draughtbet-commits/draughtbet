import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import prisma from '../../utils/db.js';

export const notificationRouter = express.Router();

// Get paginated notifications
notificationRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const { id: userId } = req.user;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.notification.count({ where: { userId } })
    ]);

    res.json({
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    next(error);
  }
});

// Mark single notification as read
notificationRouter.patch('/:id/read', requireAuth, async (req, res, next) => {
  try {
    const { id: userId } = req.user;
    const { id } = req.params;

    // Use updateMany to ensure we only update if it belongs to this user
    const result = await prisma.notification.updateMany({
      where: { id, userId },
      data: { isRead: true }
    });

    if (result.count === 0) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
});

// Mark all as read
notificationRouter.patch('/read-all', requireAuth, async (req, res, next) => {
  try {
    const { id: userId } = req.user;

    await prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true }
    });

    res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
});
