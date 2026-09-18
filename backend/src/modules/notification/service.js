import prisma from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { enqueueNotificationDelivery } from '../../services/outboxService.js';

/**
 * NotificationService
 *
 * Writes notifications to Postgres (the durable store, deduped) and enqueues a
 * durable outbox delivery event in the same transaction. Real-time delivery
 * (Socket.IO push, or the mocked FCM fallback for offline users) is performed
 * by the outbox drainer job — never inline here — so a crash between the write
 * and the push still delivers once the drainer runs (at-least-once, and the
 * dedupeKey makes a replay a no-op).
 */
export class NotificationService {
  /**
   * Persists a notification and schedules its delivery through the outbox.
   *
   * @param {string} userId - The recipient User ID
   * @param {string} type - Notification type (e.g. 'MATCH_FOUND', 'DEPOSIT_CONFIRMED')
   * @param {string} title - Notification title
   * @param {string} message - Notification message body
   * @param {string} [link] - Optional deep link or route (e.g. '/results')
   * @param {string|null} [matchId] - When set, dedupes by [userId, matchId, type]
   * @param {string} [dedupeKey] - Natural business key guarding the delivery
   *   event; derived from matchId when omitted, and REQUIRED when matchId is
   *   null (so repeat deliveries can never stack).
   */
  static async create(userId, type, title, message, link = null, matchId = null, dedupeKey = null) {
    const deliveryKey = dedupeKey ?? (matchId ? `notify:${userId}:${type}:${matchId}` : null);
    if (!deliveryKey) {
      throw new Error('NotificationService.create requires a dedupeKey (or pass matchId to derive one)');
    }

    try {
      if (matchId) {
        const existing = await prisma.notification.findFirst({
          where: { userId, matchId, type }
        });
        if (existing) return existing;
      }

      return await prisma.$transaction(async (tx) => {
        const notification = await tx.notification.create({
          data: {
            userId,
            matchId,
            type,
            title,
            message,
            link
          }
        });

        await enqueueNotificationDelivery(tx, notification, { dedupeKey: deliveryKey });
        return notification;
      });
    } catch (error) {
      // A concurrent duplicate hits the unique [userId, matchId, type] index or
      // the delivery dedupeKey; that is the same notice, not a failure.
      if (error?.code === 'P2002') {
        logger.info({ userId, type, matchId }, 'Skipped notification: existing copy');
        return null;
      }
      logger.error({ error, userId, type }, 'Failed to create notification');
      // Don't throw - notification failures shouldn't crash the main flow
    }
  }
}