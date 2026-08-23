import prisma from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { getIO } from '../../sockets/index.js';

/**
 * NotificationService
 * Handles writing notifications to Postgres and emitting them via Socket.IO
 * or (mocked) FCM based on user online presence.
 */
export class NotificationService {
  /**
   * Creates a notification and attempts real-time delivery.
   *
   * @param {string} userId - The recipient User ID
   * @param {string} type - Notification type (e.g. 'MATCH_FOUND', 'DEPOSIT_CONFIRMED')
   * @param {string} title - Notification title
   * @param {string} message - Notification message body
   * @param {string} [link] - Optional deep link or route (e.g. '/results')
   */
  static async create(userId, type, title, message, link = null) {
    try {
      // 1. Write to Postgres
      const notification = await prisma.notification.create({
        data: {
          userId,
          type,
          title,
          message,
          link,
        }
      });

      // 2. Check if user is online via Socket.IO
      const io = getIO();
      const userRoom = `user:${userId}`;
      const sockets = await io.in(userRoom).fetchSockets();

      if (sockets && sockets.length > 0) {
        // User is online -> Emit socket event
        io.to(userRoom).emit('notification', notification);
        logger.info({ userId, type, notificationId: notification.id }, 'Delivered notification via Socket.IO');
      } else {
        // User is offline -> Fallback to FCM push
        // Mocked FCM for now per user request. 
        // In reality we would look up the user's fcmToken and call firebase-admin.
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { fcmToken: true }
        });

        if (user?.fcmToken) {
          logger.info(
            { userId, type, notificationId: notification.id, fcmToken: user.fcmToken },
            '[MOCK FCM] Sent push notification to offline user'
          );
        } else {
          logger.info(
            { userId, type, notificationId: notification.id },
            'User is offline and has no FCM token. Notification saved to DB only.'
          );
        }
      }

      return notification;
    } catch (error) {
      logger.error({ error, userId, type }, 'Failed to create notification');
      // Don't throw - notification failures shouldn't crash the main transaction/flow
    }
  }
}
