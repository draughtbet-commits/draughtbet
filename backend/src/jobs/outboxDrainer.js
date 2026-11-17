import crypto from 'crypto';
import cron from 'node-cron';
import prisma from '../utils/db.js';
import logger from '../utils/logger.js';
import { getIO } from '../sockets/index.js';
import redis, { isRedisReady } from '../utils/redis.js';
import {
  OUTBOX_LEASE_MS,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_BATCH_SIZE
} from '../services/outboxService.js';

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
    getIO().to(`user:${p.userId}`).emit('wallet_updated', {
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
      createdAt: p.createdAt
    });
    if (!sockets || sockets.length === 0) {
      // Offline fallback is mocked until real FCM exists (same contract as the
      // old NotificationService: saved to DB + best-effort push logged).
      logger.info({ userId: p.userId, type: p.type, notificationId: p.notificationId }, '[MOCK FCM] Sent push notification to offline user');
    }
    return;
  }

  if (event.eventType === 'platform.config.activated') {
    const p = event.payload;
    if (isRedisReady()) {
      try {
        await redis.set('config:active:v2', JSON.stringify({
          version: p.version,
          checksum: p.checksum,
          payload: p.payload,
          activatedAt: p.activatedAt
        }), 'EX', 3600);

        await redis.publish('platform:config:invalidated', JSON.stringify({
          version: p.version,
          checksum: p.checksum,
          activatedAt: p.activatedAt
        }));
      } catch (err) {
        logger.warn({ err }, 'Failed to deliver platform.config.activated event to Redis');
        throw err;
      }
    }
    try {
      getIO()?.to('admin')?.emit('platform_config_activated', {
        version: p.version,
        checksum: p.checksum,
        activatedAt: p.activatedAt
      });
    } catch {
      // Sockets may not be active in non-server / test context
    }
    return;
  }

  if (event.eventType === 'platform.feature_flag.updated') {
    const p = event.payload;
    if (isRedisReady()) {
      try {
        if (p?.key) {
          await redis.del(`feature_flag:${String(p.key).toLowerCase()}:v2`);
        }
        await redis.publish('platform:feature_flag:invalidated', JSON.stringify({
          key: p?.key ?? null,
          enabled: p?.enabled ?? false,
          isKillSwitch: Boolean(p?.isKillSwitch),
          action: p?.action ?? 'UPDATED',
          updatedAt: p?.updatedAt ?? new Date().toISOString()
        }));
      } catch (err) {
        logger.warn({ err }, 'Failed to deliver platform.feature_flag.updated event to Redis');
        throw err;
      }
    }
    try {
      getIO()?.to('admin')?.emit('platform_feature_flag_updated', {
        key: p?.key ?? null,
        enabled: p?.enabled ?? false,
        isKillSwitch: Boolean(p?.isKillSwitch),
        action: p?.action ?? 'UPDATED',
        updatedAt: p?.updatedAt ?? null
      });
    } catch {
      // Sockets may not be active in non-server / test context
    }
    return;
  }

  if (event.eventType === 'platform.notification_template.updated') {
    const p = event.payload;
    if (isRedisReady()) {
      try {
        if (p?.code) {
          await redis.del(`notification_template:${String(p.code).toUpperCase()}:v2`);
        }
        await redis.publish('platform:notification_template:invalidated', JSON.stringify({
          code: p?.code ?? null,
          version: p?.version ?? null,
          isActive: p?.isActive ?? true,
          action: p?.action ?? 'UPDATED',
          updatedAt: p?.updatedAt ?? new Date().toISOString()
        }));
      } catch (err) {
        logger.warn({ err }, 'Failed to deliver platform.notification_template.updated event to Redis');
        throw err;
      }
    }
    try {
      getIO()?.to('admin')?.emit('platform_notification_template_updated', {
        code: p?.code ?? null,
        version: p?.version ?? null,
        isActive: p?.isActive ?? true,
        action: p?.action ?? 'UPDATED',
        updatedAt: p?.updatedAt ?? null
      });
    } catch {
      // Sockets may not be active in non-server / test context
    }
    return;
  }

  if (event.eventType === 'platform.maintenance.updated') {
    const p = event.payload;
    if (isRedisReady()) {
      try {
        await redis.del('maintenance:state:v2');
        await redis.publish('platform:maintenance:invalidated', JSON.stringify({
          active: Boolean(p?.active),
          scope: p?.scope ?? 'FULL_PLATFORM',
          action: p?.action ?? 'UPDATED',
          updatedAt: p?.updatedAt ?? new Date().toISOString()
        }));
      } catch (err) {
        logger.warn({ err }, 'Failed to deliver platform.maintenance.updated event to Redis');
        throw err;
      }
    }
    try {
      getIO()?.to('admin')?.emit('platform_maintenance_updated', {
        active: Boolean(p?.active),
        scope: p?.scope ?? 'FULL_PLATFORM',
        headline: p?.headline ?? null,
        message: p?.message ?? null,
        startsAt: p?.startsAt ?? null,
        endsAt: p?.endsAt ?? null,
        action: p?.action ?? 'UPDATED',
        updatedAt: p?.updatedAt ?? null
      });
    } catch {
      // Sockets may not be active in non-server / test context
    }
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