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
import prisma from '../src/utils/db.js';
import Redis from 'ioredis';

async function emergencyReset() {
  console.log('[EMERGENCY RESET] Connecting to database...');

  try {
    const existing = await prisma.maintenanceState.findUnique({
      where: { id: 'singleton' }
    });

    if (!existing) {
      console.log('[EMERGENCY RESET] No maintenance state record found (platform is not in maintenance).');
    } else if (!existing.isEnabled) {
      console.log('[EMERGENCY RESET] Maintenance mode is already DISABLED in database.');
    } else {
      const updated = await prisma.maintenanceState.update({
        where: { id: 'singleton' },
        data: {
          isEnabled: false,
          deactivatedAt: new Date()
        }
      });
      console.log(`[EMERGENCY RESET] Maintenance mode successfully DISABLED. Deactivated at: ${updated.deactivatedAt.toISOString()}`);
    }

    // Flush Redis maintenance state cache if Redis is configured
    if (process.env.REDIS_URL) {
      console.log('[EMERGENCY RESET] Connecting to Redis...');
      const redis = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false
      });

      try {
        await redis.del('maintenance:state:v2');
        await redis.publish('platform:maintenance:invalidated', JSON.stringify({ isEnabled: false, timestamp: Date.now() }));
        console.log('[EMERGENCY RESET] Redis maintenance cache purged and invalidation published.');
      } catch (redisErr) {
        console.warn('[EMERGENCY RESET] Warning: Could not flush Redis maintenance cache:', redisErr.message);
      } finally {
        redis.disconnect();
      }
    } else {
      console.log('[EMERGENCY RESET] REDIS_URL not set; skipping Redis cache invalidation.');
    }

    console.log('[EMERGENCY RESET] Emergency recovery completed successfully.');
  } catch (err) {
    console.error('[EMERGENCY RESET] FATAL ERROR during emergency recovery:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

emergencyReset().then(() => {
  process.exit(0);
});