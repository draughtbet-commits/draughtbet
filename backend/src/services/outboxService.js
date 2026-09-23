import logger from '../utils/logger.js';

// Shared outbox enqueue helpers.
//
// The outbox is the single durable delivery pipeline: writers enqueue an
// `OutboxEvent` inside the SAME transaction as the state change they announce
// (deposit credit, match settlement, notification, ...) and a drainer job
// delivers and marks it SENT. A crash between the tx commit and delivery just
// means the event is still PENDING and is published on the next drain cycle
// (at-least-once). Because delivery payloads are idempotent (a wallet balance
// refresh / a notification), redelivery is harmless.

// Drainer claim lease. A claimed-but-crashed event is reclaimed after this.
export const OUTBOX_LEASE_MS = 30_000;
// Max delivery attempts before an event is parked FAILED for operator review.
export const OUTBOX_MAX_ATTEMPTS = 5;
// Default batch processed per drain cycle.
export const OUTBOX_BATCH_SIZE = 50;

/**
 * Enqueues an outbox event inside the caller's transaction. When `dedupeKey`
 * is provided a replay that re-runs the same business action is a no-op (the
 * unique index swallows the duplicate insert) — used where a recovery path can
 * legitimately re-enter the writer.
 */
export async function enqueueEvent(tx, { aggregateType, aggregateId, eventType, payload, dedupeKey = null }) {
  // Check-first idempotency: an insert that hits the dedupeKey unique index
  // raises P2002, which aborts the caller's live transaction (the error can't
  // be safely swallowed mid-tx). Exactly like the ledger's replay guard.
  if (dedupeKey !== null && dedupeKey !== undefined) {
    const existing = await tx.outboxEvent.findUnique({ where: { dedupeKey } });
    if (existing) {
      logger.info({ eventType, dedupeKey }, 'Outbox event already enqueued (replay)');
      return null;
    }
  }
  try {
    return await tx.outboxEvent.create({
      data: { aggregateType, aggregateId, eventType, payload, dedupeKey }
    });
  } catch (error) {
    if (error?.code === 'P2002' && dedupeKey) {
      logger.info({ eventType, dedupeKey }, 'Outbox event raced by a concurrent enqueue');
      return null;
    }
    throw error;
  }
}

/**
 * Shorthand for enqueueing the durable delivery of a just-created notification
 * row. The drainer sees the 'notification' eventType and delivers it over the
 * socket (or the FCM fallback); `dedupeKey` MUST be derived from the natural
 * unique business key so a replay never stacks a second delivery.
 */
export async function enqueueNotificationDelivery(tx, notification, { dedupeKey }) {
  if (!dedupeKey) {
    throw new Error('enqueueNotificationDelivery requires a dedupeKey');
  }
  return enqueueEvent(tx, {
    aggregateType: 'Notification',
    aggregateId: notification.id,
    eventType: 'notification',
    dedupeKey,
    payload: {
      notificationId: notification.id,
      userId: notification.userId,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      link: notification.link ?? null,
      matchId: notification.matchId ?? null,
      createdAt: notification.createdAt ? notification.createdAt.toISOString() : null
    }
  });
}

/**
 * Durable wallet.updated delivery. The payload mirrors the legacy inline socket
 * push (balanceChange = signed amount, plus metadata) so clients can keep
 * refreshing their balance from it.
 */
export async function enqueueWalletUpdated(tx, { userId, walletId, currency, type, amountMinorUnits, matchId = null, dedupeKey = null }) {
  return enqueueEvent(tx, {
    aggregateType: 'Wallet',
    aggregateId: walletId,
    eventType: 'wallet.updated',
    dedupeKey,
    payload: {
      userId,
      walletId,
      currency,
      type,
      balanceChange: amountMinorUnits.toString(),
      amountMinorUnits: amountMinorUnits.toString(),
      matchId
    }
  });
}