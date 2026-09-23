import crypto from 'crypto';
import prisma from '../utils/db.js';
import logger from '../utils/logger.js';

// Versioned platform config + frozen rulesets.
//
// PlatformConfigVersion records a full immutable snapshot of the live
// platformSettings singleton each time it changes (active singletons have
// activeTo NULL). RulesetVersion freezes the competing-rules parameters for a
// given engine build; a match is stamped with the active ruleset and the
// config version in effect at funding time, so later edits can never
// retroactively change what a match was played under.

export const RULESET_SCALARS = [
  'timeControlSeconds',
  'disconnectGraceSeconds'
];

export const INT_SCALARS = ['commissionPercent', 'limitRaiseCoolingHours', 'timeControlSeconds'];

export const SETTINGS_SCALARS = [
  ...INT_SCALARS,
  'amateurStakeMinP',
  'amateurStakeMaxP',
  'masterStakeMinP',
  'masterStakeMaxP',
  'proStakeMinP',
  'proStakeMaxP',
  'amateurCalloutMaxP',
  'masterCalloutMaxP',
  'proCalloutMaxP'
];

export const DEFAULT_ENGINE_VERSION = 'draughts-engine-v1';

// JSONB has no BigInt: serialize money fields as decimal strings in the
// immutable snapshot (and on ingest, convert them back the same way).
const jsonValue = (value) => (typeof value === 'bigint' ? value.toString() : value);

const snapshotOf = (settings) =>
  Object.fromEntries(SETTINGS_SCALARS.map((k) => [k, jsonValue(settings[k])]));

const checksumOf = (values) => crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex');

/**
 * Resolves the active frozen ruleset id inside a caller transaction.
 * Returns null if the client has no such model (pre-migration DB) so match
 * creation never hard-fails on schema lag.
 */
export async function resolveActiveRuleset(client) {
  if (!client?.rulesetVersion?.findFirst) return null;
  const ruleset = await client.rulesetVersion.findFirst({ where: { active: true } });
  return ruleset?.id ?? null;
}

/**
 * Resolves the active (unclosed) platform config version id.
 */
export async function resolveActiveConfigVersion(client) {
  if (!client?.platformConfigVersion?.findFirst) return null;
  const version = await client.platformConfigVersion.findFirst({
    where: { activeTo: null },
    orderBy: { activeFrom: 'desc' }
  });
  return version?.id ?? null;
}

/**
 * Boot seed: makes sure an active RulesetVersion and an active
 * PlatformConfigVersion exist once. Idempotent — later boots are no-ops.
 */
export async function ensureActiveConfigVersions() {
  const hasRuleset = await prisma.rulesetVersion.count({ where: { active: true } });
  if (hasRuleset === 0) {
    await prisma.rulesetVersion.create({
      data: {
        id: 'draughts-x1-w',
        displayName: 'Standard draughts (WS rules)',
        engineVersion: DEFAULT_ENGINE_VERSION,
        active: true,
        config: { rules: 'standard-w', timeControlSeconds: 60 }
      }
    });
    logger.info('Seeded active RulesetVersion draughts-x1-w');
  }

  const hasConfig = await prisma.platformConfigVersion.count({ where: { activeTo: null } });
  if (hasConfig === 0) {
    const settings = await prisma.platformSettings.findUnique({ where: { id: 'singleton' } });
    if (settings) {
      const values = snapshotOf(settings);
      await prisma.platformConfigVersion.create({
        data: { version: 'v1', values, checksum: checksumOf(values) }
      });
      logger.info('Seeded active PlatformConfigVersion v1');
    }
  }
  return { rulesetSeed: hasRuleset === 0, configSeed: hasConfig === 0 };
}

/**
 * Admin platform-settings update: writes the singleton scalars, closes the
 * currently active PlatformConfigVersion and appends a new immutable snapshot.
 */
export async function updatePlatformConfig({ userId, updates }) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.platformSettings.findUnique({ where: { id: 'singleton' } });
    if (!current) throw new Error('Platform settings not configured');

    const data = {};
    for (const key of SETTINGS_SCALARS) {
      if (updates[key] === undefined) continue;
      data[key] = INT_SCALARS.includes(key)
        ? Number(updates[key])
        : BigInt(updates[key].toString());
    }
    if (Object.keys(data).length === 0) {
      throw new Error('No supported settings supplied');
    }

    const updated = await tx.platformSettings.update({ where: { id: 'singleton' }, data });

    const active = await tx.platformConfigVersion.findFirst({
      where: { activeTo: null },
      orderBy: { activeFrom: 'desc' }
    });
    if (active) {
      await tx.platformConfigVersion.update({
        where: { id: active.id },
        data: { activeTo: new Date() }
      });
    }

    const serial = await tx.platformConfigVersion.count();
    const values = snapshotOf({ ...current, ...data });
    await tx.platformConfigVersion.create({
      data: {
        version: `v${serial + 1}`,
        values,
        checksum: checksumOf(values),
        createdByUserId: userId
      }
    });

    return updated;
  });
}

/** JSON-safe settings projection for API responses (BigInt -> decimal string). */
export const settingsPayload = (settings) =>
  Object.fromEntries(SETTINGS_SCALARS.map((k) => [k, jsonValue(settings[k])]));

export default {
  RULESET_SCALARS,
  SETTINGS_SCALARS,
  resolveActiveRuleset,
  resolveActiveConfigVersion,
  ensureActiveConfigVersions,
  updatePlatformConfig,
  settingsPayload
};