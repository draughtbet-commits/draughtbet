#!/usr/bin/env node

/**
 * Draught Bet — Phase 4 Emergency Maintenance Reset Tool
 *
 * Standalone operational script to immediately disable maintenance mode
 * out-of-band directly against PostgreSQL and flush Redis maintenance caches.
 *
 * Safe to execute during emergency recovery even if web servers or the
 * admin web interface are inaccessible or unresponsive.
 *
 * Usage:
 *   node backend/scripts/emergencyMaintenanceReset.js
 */

import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import prisma from '../src/utils/db.js';
import Redis from 'ioredis';

/**
 * Core emergency maintenance reset routine.
 * Exported for deterministic unit/integration testing and invoked by CLI entrypoint.
 */
export async function runEmergencyMaintenanceReset({
  dbp = prisma,
  redisUrl = process.env.REDIS_URL,
  redisFactory = (url) =>
    new Redis(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false
    })
} = {}) {
  console.log('[EMERGENCY RESET] Connecting to database...');

  const existing = await dbp.maintenanceState.findUnique({
    where: { id: 'singleton' }
  });

  const now = new Date();
  let wasActive = false;
  let updatedRecord = existing ?? null;

  if (!existing) {
    console.log('[EMERGENCY RESET] No maintenance state record found (platform is not in maintenance).');
  } else if (!(existing.active ?? existing.isEnabled ?? false)) {
    console.log('[EMERGENCY RESET] Maintenance mode is already DISABLED in database.');
  } else {
    wasActive = true;
    updatedRecord = await dbp.maintenanceState.update({
      where: { id: 'singleton' },
      data: {
        active: false,
        startsAt: null,
        endsAt: now
      }
    });
    const endedIso = (updatedRecord.endsAt ?? now).toISOString();
    console.log(
      `[EMERGENCY RESET] Maintenance mode successfully DISABLED. Deactivated at: ${endedIso}`
    );
  }

  // Flush Redis maintenance state cache if Redis is configured
  let redisPurged = false;
  if (redisUrl) {
    console.log('[EMERGENCY RESET] Connecting to Redis...');
    const redisClient = redisFactory(redisUrl);

    try {
      await redisClient.del('maintenance:state:v2');
      await redisClient.publish(
        'platform:maintenance:invalidated',
        JSON.stringify({ active: false, isEnabled: false, timestamp: Date.now() })
      );
      redisPurged = true;
      console.log('[EMERGENCY RESET] Redis maintenance cache purged and invalidation published.');
    } catch (redisErr) {
      console.warn('[EMERGENCY RESET] Warning: Could not flush Redis maintenance cache:', redisErr.message);
    } finally {
      if (typeof redisClient.disconnect === 'function') {
        redisClient.disconnect();
      }
    }
  } else {
    console.log('[EMERGENCY RESET] REDIS_URL not set; skipping Redis cache invalidation.');
  }

  console.log('[EMERGENCY RESET] Emergency recovery completed successfully.');
  return {
    wasActive,
    active: false,
    deactivatedAt: now,
    redisPurged,
    maintenanceState: updatedRecord
  };
}

const isMainModule = () => {
  try {
    if (!process.argv[1]) return false;
    const entryPath = path.resolve(process.argv[1]);
    const currentPath = path.resolve(fileURLToPath(import.meta.url));
    return entryPath === currentPath;
  } catch {
    return false;
  }
};

if (isMainModule()) {
  runEmergencyMaintenanceReset()
    .then(() => prisma.$disconnect())
    .then(() => {
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('[EMERGENCY RESET] FATAL ERROR during emergency recovery:', err);
      await prisma.$disconnect().catch(() => {});
      process.exit(1);
    });
}
