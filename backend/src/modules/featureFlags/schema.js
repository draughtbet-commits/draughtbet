import crypto from 'node:crypto';
import { z } from 'zod';
import { ADMIN_ROLES } from '../rbac/permissions.js';

export const VALID_TIERS = Object.freeze(['AMATEUR', 'MASTER', 'PRO']);

export const FEATURE_FLAG_KEY_REGEX = /^[a-z][a-z0-9_.-]{1,63}$/;

/**
 * Core platform invariants that can NEVER be disabled or diluted via feature flags.
 * Attempting to disable, reduce rollout below 100%, restrict tiers, or delete
 * any flag matching these keys (or carrying `isProtectedInvariant: true` in metadata)
 * is rejected by the backend service.
 */
export const PROTECTED_INVARIANT_KEYS = Object.freeze([
  'enforce_kyc_on_withdrawal',
  'enforce_ledger_double_entry',
  'enforce_safer_play_limits',
  'enforce_match_snapshot_isolation',
  'enforce_admin_rbac'
]);

/**
 * Metadata keys that are strictly forbidden on feature flags because feature flags
 * must NEVER grant administrative permissions or bypass backend security controls.
 */
export const FORBIDDEN_METADATA_KEYS = Object.freeze([
  'grantsPermissions',
  'grantPermissions',
  'overridePermissions',
  'bypassRbac',
  'bypassKyc',
  'bypassSaferPlay',
  'bypassLedger',
  'allowDirectBalanceSet'
]);

export const FeatureFlagKeySchema = z
  .string()
  .trim()
  .refine((val) => FEATURE_FLAG_KEY_REGEX.test(val), {
    message:
      'Feature flag key must be 2-64 characters, start with a lowercase letter, and contain only lowercase letters, digits, underscores, dots, or hyphens'
  });

export const TierEnumSchema = z.enum(VALID_TIERS);
export const AdminRoleEnumSchema = z.enum(ADMIN_ROLES);

export const FeatureFlagMetadataSchema = z
  .record(z.string(), z.unknown())
  .nullable()
  .optional()
  .superRefine((meta, ctx) => {
    if (!meta || typeof meta !== 'object') return;
    for (const forbidden of FORBIDDEN_METADATA_KEYS) {
      if (Object.prototype.hasOwnProperty.call(meta, forbidden) && meta[forbidden]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [forbidden],
          message: `Feature flag metadata cannot include '${forbidden}': feature flags must never grant permissions or bypass backend controls`
        });
      }
    }
  });

export const CreateFeatureFlagSchema = z.object({
  key: FeatureFlagKeySchema,
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(120, 'Name cannot exceed 120 characters'),
  description: z.string().trim().max(500, 'Description cannot exceed 500 characters').nullable().optional(),
  enabled: z.boolean().default(false),
  rolloutPercentage: z
    .number()
    .int('Rollout percentage must be an integer')
    .min(0, 'Rollout percentage cannot be less than 0')
    .max(100, 'Rollout percentage cannot exceed 100')
    .default(100),
  allowedTiers: z
    .array(TierEnumSchema)
    .default([])
    .transform((arr) => Array.from(new Set(arr))),
  allowedRoles: z
    .array(AdminRoleEnumSchema)
    .default([])
    .transform((arr) => Array.from(new Set(arr))),
  isKillSwitch: z.boolean().default(false),
  metadata: FeatureFlagMetadataSchema,
  changeReason: z
    .string()
    .trim()
    .min(5, 'A change reason of at least 5 characters is required')
    .max(500)
    .optional()
});

export const UpdateFeatureFlagSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    enabled: z.boolean().optional(),
    rolloutPercentage: z.number().int().min(0).max(100).optional(),
    allowedTiers: z
      .array(TierEnumSchema)
      .transform((arr) => Array.from(new Set(arr)))
      .optional(),
    allowedRoles: z
      .array(AdminRoleEnumSchema)
      .transform((arr) => Array.from(new Set(arr)))
      .optional(),
    isKillSwitch: z.boolean().optional(),
    metadata: FeatureFlagMetadataSchema,
    changeReason: z
      .string()
      .trim()
      .min(5, 'A change reason of at least 5 characters is required')
      .max(500)
      .optional()
  })
  .refine(
    (data) =>
      data.name !== undefined ||
      data.description !== undefined ||
      data.enabled !== undefined ||
      data.rolloutPercentage !== undefined ||
      data.allowedTiers !== undefined ||
      data.allowedRoles !== undefined ||
      data.isKillSwitch !== undefined ||
      data.metadata !== undefined,
    { message: 'At least one field must be provided to update a feature flag' }
  );

/**
 * Checks whether a feature flag record or candidate represents a protected platform invariant.
 *
 * @param {object} flag
 * @returns {boolean}
 */
export function isProtectedInvariantFlag(flag) {
  if (!flag) return false;
  if (flag.isProtectedInvariant === true) return true;
  if (flag.metadata && typeof flag.metadata === 'object' && flag.metadata.isProtectedInvariant === true) {
    return true;
  }
  if (typeof flag.key === 'string' && PROTECTED_INVARIANT_KEYS.includes(flag.key)) {
    return true;
  }
  return false;
}

/**
 * Deterministically maps `(flagKey, subjectId)` into an integer bucket in `[0, 99]`
 * using SHA-256.
 *
 * Guarantees:
 * - Identical inputs always yield the exact same bucket across all processes and servers.
 * - Monotonic rollout expansion: a subject in the 20% cohort (buckets 0..19) remains
 *   included when rollout increases to 50% (buckets 0..49).
 *
 * @param {string} flagKey
 * @param {string} subjectId
 * @returns {number} Integer in range 0..99
 */
export function computeRolloutBucket(flagKey, subjectId) {
  const normalizedKey = String(flagKey ?? '').trim().toLowerCase();
  const normalizedSubject = String(subjectId ?? '').trim();
  const hash = crypto
    .createHash('sha256')
    .update(`${normalizedKey}:${normalizedSubject}`, 'utf8')
    .digest();
  const uint32 = hash.readUInt32BE(0);
  return uint32 % 100;
}

/**
 * Baseline default feature flags for Draught Bet.
 */
export const DEFAULT_FEATURE_FLAGS = Object.freeze([
  {
    key: 'enforce_kyc_on_withdrawal',
    name: 'Enforce KYC Verification on Withdrawals',
    description: 'Protected compliance invariant: requires verified KYC before withdrawal payouts above threshold.',
    enabled: true,
    rolloutPercentage: 100,
    allowedTiers: [],
    allowedRoles: ['SUPER_ADMIN', 'RISK_COMPLIANCE', 'READ_ONLY_AUDITOR'],
    isKillSwitch: false,
    metadata: { isProtectedInvariant: true, category: 'COMPLIANCE' }
  },
  {
    key: 'callout_challenges_enabled',
    name: 'High-Stakes Call-Out Challenges',
    description: 'Allows eligible Master and Pro tier players to create and accept direct call-out challenges.',
    enabled: true,
    rolloutPercentage: 100,
    allowedTiers: ['MASTER', 'PRO'],
    allowedRoles: ['SUPER_ADMIN', 'GAME_OPERATIONS', 'SUPPORT', 'READ_ONLY_AUDITOR'],
    isKillSwitch: true,
    metadata: { category: 'GAMEPLAY' }
  },
  {
    key: 'live_matchmaking_queue',
    name: 'Live Matchmaking Queue',
    description: 'Master kill-switch for automated matchmaking queue entry across all tiers.',
    enabled: true,
    rolloutPercentage: 100,
    allowedTiers: ['AMATEUR', 'MASTER', 'PRO'],
    allowedRoles: ['SUPER_ADMIN', 'GAME_OPERATIONS', 'READ_ONLY_AUDITOR'],
    isKillSwitch: true,
    metadata: { category: 'MATCHMAKING' }
  },
  {
    key: 'new_withdrawals_submission',
    name: 'New Withdrawal Requests Submission',
    description: 'Operational kill-switch for new player withdrawal submissions during payment gateway incidents.',
    enabled: true,
    rolloutPercentage: 100,
    allowedTiers: ['AMATEUR', 'MASTER', 'PRO'],
    allowedRoles: ['SUPER_ADMIN', 'FINANCE', 'RISK_COMPLIANCE', 'READ_ONLY_AUDITOR'],
    isKillSwitch: true,
    metadata: { category: 'FINANCIAL' }
  },
  {
    key: 'enhanced_match_replay_viewer',
    name: 'Enhanced Match Replay & Evidence Timeline',
    description: 'Gradual rollout of the rich move-by-move board replay and clock telemetry viewer.',
    enabled: true,
    rolloutPercentage: 50,
    allowedTiers: ['AMATEUR', 'MASTER', 'PRO'],
    allowedRoles: ['SUPER_ADMIN', 'GAME_OPERATIONS', 'SUPPORT', 'READ_ONLY_AUDITOR'],
    isKillSwitch: false,
    metadata: { category: 'UI_ROLLOUT' }
  }
]);
