import crypto from 'crypto';
import cron from 'node-cron';
import prisma from '../utils/db.js';
import logger from '../utils/logger.js';
import { getIO } from '../sockets/index.js';
import { getUserLedgerProjections } from '../services/ledgerService.js';
import { sendToUser, isPushConfigured } from '../services/pushService.js';
import { sendEmail } from '../services/emailService.js';
import { notificationEmail } from '../services/emailTemplates.js';
import {
  OUTBOX_LEASE_MS,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_BATCH_SIZE
} from '../services/outboxService.js';

// Notification types that also warrant an email (a record the player can keep,
// or an out-of-app alert). Real-time game events (challenges, results) stay
// in-app/push only — emailing them would be noise.
export const EMAIL_NOTIFICATION_TYPES = new Set([
  'DEPOSIT_CONFIRMED',
  'DEPOSIT_FAILED',
  'WITHDRAWAL_PENDING',
  'WITHDRAWAL_CONFIRMED',
  'WITHDRAWAL_REFUNDED',
  'ACCOUNT_SUSPENDED',
  'ACCOUNT_REINSTATED'
]);

/**
 * Best-effort email mirror of an in-app notification. Never throws: the outbox
 * event must settle on socket/push success regardless of mail delivery, so a
 * lookup or provider failure is logged and swallowed.
 */
const emailNotificationIfWarranted = async (p) => {
  if (!EMAIL_NOTIFICATION_TYPES.has(p.type)) return;
  try {
    const user = await prisma.user.findUnique({
      where: { id: p.userId },
      select: { email: true, fullName: true }
    });
    if (!user?.email) return;
    await sendEmail({
      to: user.email,
      ...notificationEmail({ name: user.fullName, title: p.title, message: p.message })
    });
  } catch (err) {
    logger.warn({ err, userId: p.userId, type: p.type }, 'Notification email failed (non-blocking)');
  }
};

// Outbox drainer: publishes PENDING OutboxEvent rows and marks them SENT.
//
//   claim    a batch of lease-free PENDING rows with a unique token + expiry
//   deliver  socket push per event (at-least-once delivery is safe because
//            every payload is a harmless idempotent refresh)
//   settle   mark SENT (only the claimer via CAS), or back off / FAIL
//
// Restart-safe: a crash between claim and SENT leaves the lease to expire, so
// the next cycle reclaims the row and delivers it. Because writers enqueue in
// the SAME transaction as the state change they announce, a crash before the
// commit loses nothing — the row never exists.

/**
 * Delivers a single claimed event. Throws when delivery fails (the drainer
 * then backs off / parks the row) and when the eventType is unknown (a hard
 * product bug — parked FAILED so it stops spinning).
 */
export const deliverEvent = async (event) => {
  if (event.eventType === 'wallet.updated') {
    const p = event.payload;
    const io = getIO();
    const userRoom = `user:${p.userId}`;

    // Contract projections (availableMinor/lockedMinor/withdrawalPendingMinor)
    // are resolved from the ledger at delivery time so the pushed balance is
    // always authoritative and post-event. Best-effort: a read failure degrades
    // to nulls rather than failing the delivery (the legacy payload still has
    // the signed change).
    const projections = { availableMinor: null, lockedMinor: null, withdrawalPendingMinor: null };
    try {
      const wallet = await prisma.wallet.findUnique({
        where: { userId: p.userId },
        select: { currency: true }
      });
      if (wallet) {
        const g = await getUserLedgerProjections(prisma, p.userId, wallet.currency ?? 'NGN');
        projections.availableMinor = g.available;
        projections.lockedMinor = g.locked;
        projections.withdrawalPendingMinor = g.pending;
      }
    } catch (err) {
      logger.warn({ err, userId: p.userId }, 'Wallet projections read failed; delivering legacy payload');
    }

    // V2 contract event (socket contract v1 line 29) + the legacy alias the
    // deployed Flutter client still listens for.
    io.to(userRoom).emit('wallet.updated', {
      userId: p.userId,
      reason: p.type,
      ...projections,
      balanceChange: p.balanceChange,
      type: p.type,
      matchId: p.matchId ?? null
    });
    io.to(userRoom).emit('wallet_updated', {
      balanceChange: p.balanceChange,
      type: p.type,
      matchId: p.matchId ?? null
    });
    return;
  }

  if (event.eventType === 'notification') {
    const p = event.payload;
    const io = getIO();
    const userRoom = `user:${p.userId}`;
    const sockets = await io.in(userRoom).fetchSockets();
    io.to(userRoom).emit('notification', {
      id: p.notificationId,
      userId: p.userId,
      type: p.type,
      title: p.title,
      message: p.message,
      link: p.link,
      matchId: p.matchId,
      isRead: p.isRead ?? false,
      createdAt: p.createdAt
    });
    if (!sockets || sockets.length === 0) {
      // Offline fallback: the player has no live socket, so deliver a push to
      // their registered devices. Best-effort — `sendToUser` never throws, so a
      // push failure cannot park the outbox event; the DB row is the source of
      // truth and the socket push is the live path.
      if (isPushConfigured()) {
        const summary = await sendToUser(p.userId, {
          title: p.title,
          body: p.message,
          data: {
            notificationId: p.notificationId,
            type: p.type,
            link: p.link ?? '',
            matchId: p.matchId ?? ''
          }
        });
        logger.info({ userId: p.userId, type: p.type, notificationId: p.notificationId, ...summary }, 'Offline push delivered');
      } else {
        logger.info({ userId: p.userId, type: p.type, notificationId: p.notificationId }, 'Push skipped (FCM not configured) for offline user');
      }
    }
    // Email is independent of online state: send it whether or not the player
    // had a live socket.
    await emailNotificationIfWarranted(p);
    return;
  }

  throw new Error(`Outbox drainer cannot deliver unknown eventType: ${event.eventType}`);
};

const leaseExpired = (row, at) => row.claimExpiresAt === null || row.claimExpiresAt.getTime() < at;

/**
 * Claims up to batchSize lease-free PENDING events, delivers each and settles
 * it (SENT) or backs it off (attempts++, cleared lease) / parks it (FAILED at
 * max attempts). Returns { claimed, delivered, backoff, failed } for callers
 * and tests.
 */
export async function processOutboxDrainer({
  batchSize = OUTBOX_BATCH_SIZE,
  leaseMs = OUTBOX_LEASE_MS,
  maxAttempts = OUTBOX_MAX_ATTEMPTS,
  clock = () => new Date(),
  deliver = deliverEvent
} = {}) {
  const start = clock();

  const pending = await prisma.outboxEvent.findMany({
    where: {
      status: 'PENDING',
      OR: [{ claimExpiresAt: null }, { claimExpiresAt: { lt: start } }]
    },
    orderBy: { createdAt: 'asc' },
    take: batchSize
  });

  const claimed = [];
  for (const row of pending) {
    if (!leaseExpired(row, start.getTime())) continue;
    const claimToken = crypto.randomUUID();
    const won = await prisma.outboxEvent.updateMany({
      where: {
        id: row.id,
        status: 'PENDING',
        OR: [{ claimExpiresAt: null }, { claimExpiresAt: { lt: start } }]
      },
      data: { claimToken, claimExpiresAt: new Date(start.getTime() + leaseMs) }
    });
    if (won.count === 1) claimed.push({ ...row, claimToken });
  }

  let delivered = 0;
  let backoff = 0;
  let failed = 0;
  for (const event of claimed) {
    try {
      await deliver(event);
      await prisma.outboxEvent.updateMany({
        where: { id: event.id, claimToken: event.claimToken },
        data: { status: 'SENT', claimToken: null, claimExpiresAt: null, lastError: null }
      });
      delivered++;
      logger.info({ eventType: event.eventType, aggregateId: event.aggregateId }, 'Outbox event delivered');
    } catch (err) {
      const attempts = event.attempts + 1;
      const isPermanent = attempts >= maxAttempts;
      await prisma.outboxEvent.updateMany({
        where: { id: event.id, claimToken: event.claimToken },
        data: isPermanent
          ? { status: 'FAILED', claimToken: null, claimExpiresAt: null, attempts, lastError: err.message }
          : { claimToken: null, claimExpiresAt: null, attempts, lastError: err.message }
      });
      if (isPermanent) {
        failed++;
        logger.error({ err, eventType: event.eventType, aggregateId: event.aggregateId }, 'Outbox event parked FAILED after max attempts');
      } else {
        backoff++;
        logger.warn({ err, eventType: event.eventType, attempts }, 'Outbox event delivery failed, will retry');
      }
    }
  }

  if (claimed.length > 0) {
    logger.info({ scanned: pending.length, claimed: claimed.length, delivered, backoff, failed }, 'Outbox drain cycle complete');
  }
  return { scanned: pending.length, claimed: claimed.length, delivered, backoff, failed };
}

let isDraining = false;

export const startOutboxDrainer = () => {
  // Every second: drain is cheap when empty (single indexed read) and keeps
  // socket delivery latency to ~1s.
  return cron.schedule('*/1 * * * * *', async () => {
    if (isDraining) return;
    isDraining = true;
    try {
      await processOutboxDrainer();
    } catch (err) {
      logger.error({ err }, 'Outbox drainer cycle failed');
    } finally {
      isDraining = false;
    }
  });
};