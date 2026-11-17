import { z } from 'zod';

/**
 * Regex for positive integer minor units (kobo).
 * Rejects decimal points, negative signs, leading zeros (unless "0"), and non-digit characters.
 */
const MINOR_UNITS_REGEX = /^(0|[1-9]\d*)$/;

export const minorUnitsSchema = z.string().refine((val) => MINOR_UNITS_REGEX.test(val), {
  message: 'Must be a non-negative integer string representing minor units (kobo)'
});

export const positiveMinorUnitsSchema = z.string().refine((val) => /^[1-9]\d*$/.test(val), {
  message: 'Must be a strictly positive integer string representing minor units (kobo)'
});

const TierStakeConfigSchema = z.object({
  minStake: positiveMinorUnitsSchema,
  maxStake: positiveMinorUnitsSchema,
  maxCallout: minorUnitsSchema
});

export const CONFIG_DOMAINS = Object.freeze({
  PLATFORM: 'PLATFORM',
  FINANCIAL: 'FINANCIAL',
  TIERS: 'TIERS',
  GAME: 'GAME',
  MATCHMAKING: 'MATCHMAKING',
  SAFER_PLAY: 'SAFER_PLAY',
  KYC: 'KYC'
});

export const RESTRICTED_DOMAINS = Object.freeze([
  CONFIG_DOMAINS.FINANCIAL,
  CONFIG_DOMAINS.TIERS,
  CONFIG_DOMAINS.SAFER_PLAY,
  CONFIG_DOMAINS.KYC
]);

export const PlatformConfigPayloadSchema = z
  .object({
    meta: z.object({
      schemaVersion: z.number().int().positive(),
      environment: z.enum(['development', 'test', 'staging', 'production'])
    }),
    platform: z.object({
      identity: z.string().min(1).max(100),
      defaultCurrency: z.literal('NGN'),
      supportedCurrencies: z.array(z.string().min(3).max(3)).min(1),
      supportEmail: z.string().email()
    }),
    financial: z.object({
      commissionPercent: z.number().int().min(1).max(25),
      minDepositMinorUnits: positiveMinorUnitsSchema,
      maxDepositMinorUnits: positiveMinorUnitsSchema,
      minWithdrawalMinorUnits: positiveMinorUnitsSchema,
      maxWithdrawalMinorUnits: positiveMinorUnitsSchema,
      dailyWithdrawalCeilingMinorUnits: positiveMinorUnitsSchema
    }),
    tiers: z.object({
      AMATEUR: TierStakeConfigSchema,
      MASTER: TierStakeConfigSchema,
      PRO: TierStakeConfigSchema
    }),
    game: z.object({
      rulesetVersion: z.number().int().positive(),
      timeControlSeconds: z.number().int().min(15).max(300),
      matchReadinessSeconds: z.number().int().min(10).max(120),
      disconnectGraceMs: z.number().int().min(10000).max(180000),
      maxConsecutiveKingMoves: z.number().int().min(20).max(100),
      canOfferDrawPlyCount: z.number().int().min(40).max(200)
    }),
    matchmaking: z.object({
      queueTimeoutSeconds: z.number().int().min(30).max(600),
      cronTickSeconds: z.number().int().min(1).max(15),
      maxConcurrentQueuePerPlayer: z.number().int().min(1).max(1)
    }),
    saferPlay: z.object({
      limitRaiseCoolingHours: z.number().int().min(24).max(168),
      minTimeoutDurationMinutes: z.number().int().min(15).max(1440),
      minSelfExclusionDays: z.number().int().min(180).max(3650)
    }),
    kyc: z.object({
      // KYC threshold has its own independent business meaning and is not bound to minWithdrawal
      mandatoryWithdrawalThresholdMinorUnits: minorUnitsSchema,
      requireVerificationForCallouts: z.boolean(),
      allowedCountries: z.array(z.string().length(2)).min(1)
    })
  })
  .superRefine((data, ctx) => {
    const safeBigInt = (val) => {
      if (typeof val === 'string' && /^[0-9]+$/.test(val)) {
        try {
          return BigInt(val);
        } catch {
          return null;
        }
      }
      return null;
    };

    // 1. Financial co-dependent boundaries
    const minDep = safeBigInt(data.financial.minDepositMinorUnits);
    const maxDep = safeBigInt(data.financial.maxDepositMinorUnits);
    if (minDep !== null && maxDep !== null && minDep > maxDep) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['financial', 'minDepositMinorUnits'],
        message: 'minDepositMinorUnits cannot exceed maxDepositMinorUnits'
      });
    }

    const minWd = safeBigInt(data.financial.minWithdrawalMinorUnits);
    const maxWd = safeBigInt(data.financial.maxWithdrawalMinorUnits);
    if (minWd !== null && maxWd !== null && minWd > maxWd) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['financial', 'minWithdrawalMinorUnits'],
        message: 'minWithdrawalMinorUnits cannot exceed maxWithdrawalMinorUnits'
      });
    }

    // 2. Tier stake progression boundaries
    // Overlapping tier ranges ARE permitted (e.g. Amateur 500 - 15,000, Master 10,000 - 30,000)
    // but internal and cross-tier progression must be strictly monotonic.
    const amateurMin = safeBigInt(data.tiers.AMATEUR.minStake);
    const amateurMax = safeBigInt(data.tiers.AMATEUR.maxStake);
    if (amateurMin !== null && amateurMax !== null && amateurMin >= amateurMax) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tiers', 'AMATEUR', 'minStake'],
        message: 'AMATEUR minStake must be strictly less than maxStake'
      });
    }

    const masterMin = safeBigInt(data.tiers.MASTER.minStake);
    const masterMax = safeBigInt(data.tiers.MASTER.maxStake);
    if (masterMin !== null && masterMax !== null && masterMin >= masterMax) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tiers', 'MASTER', 'minStake'],
        message: 'MASTER minStake must be strictly less than maxStake'
      });
    }

    const proMin = safeBigInt(data.tiers.PRO.minStake);
    const proMax = safeBigInt(data.tiers.PRO.maxStake);
    if (proMin !== null && proMax !== null && proMin >= proMax) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tiers', 'PRO', 'minStake'],
        message: 'PRO minStake must be strictly less than maxStake'
      });
    }

    // Monotonic progression across tiers:
    // AMATEUR.minStake <= MASTER.minStake <= PRO.minStake
    // AMATEUR.maxStake <= MASTER.maxStake <= PRO.maxStake
    if (amateurMin !== null && masterMin !== null && amateurMin > masterMin) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tiers', 'MASTER', 'minStake'],
        message: 'MASTER minStake must be greater than or equal to AMATEUR minStake'
      });
    }

    if (masterMin !== null && proMin !== null && masterMin > proMin) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tiers', 'PRO', 'minStake'],
        message: 'PRO minStake must be greater than or equal to MASTER minStake'
      });
    }

    if (amateurMax !== null && masterMax !== null && amateurMax > masterMax) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tiers', 'MASTER', 'maxStake'],
        message: 'MASTER maxStake must be greater than or equal to AMATEUR maxStake'
      });
    }

    if (masterMax !== null && proMax !== null && masterMax > proMax) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tiers', 'PRO', 'maxStake'],
        message: 'PRO maxStake must be greater than or equal to MASTER maxStake'
      });
    }
  });

/**
 * Baseline default canonical configuration for Draught Bet.
 */
export const DEFAULT_CONFIG_PAYLOAD = Object.freeze({
  meta: {
    schemaVersion: 1,
    environment: 'production'
  },
  platform: {
    identity: 'Draught Bet',
    defaultCurrency: 'NGN',
    supportedCurrencies: ['NGN'],
    supportEmail: 'support@draughtbet.com'
  },
  financial: {
    commissionPercent: 10,
    minDepositMinorUnits: '100000', // ₦1,000
    maxDepositMinorUnits: '50000000', // ₦500,000
    minWithdrawalMinorUnits: '200000', // ₦2,000
    maxWithdrawalMinorUnits: '100000000', // ₦1,000,000
    dailyWithdrawalCeilingMinorUnits: '500000000' // ₦5,000,000
  },
  tiers: {
    AMATEUR: { minStake: '50000', maxStake: '1500000', maxCallout: '0' },
    MASTER: { minStake: '1000000', maxStake: '3000000', maxCallout: '15000000' },
    PRO: { minStake: '3000000', maxStake: '6000000', maxCallout: '30000000' }
  },
  game: {
    rulesetVersion: 1,
    timeControlSeconds: 60,
    matchReadinessSeconds: 30,
    disconnectGraceMs: 60000,
    maxConsecutiveKingMoves: 50,
    canOfferDrawPlyCount: 80
  },
  matchmaking: {
    queueTimeoutSeconds: 120,
    cronTickSeconds: 3,
    maxConcurrentQueuePerPlayer: 1
  },
  saferPlay: {
    limitRaiseCoolingHours: 24,
    minTimeoutDurationMinutes: 60,
    minSelfExclusionDays: 180
  },
  kyc: {
    mandatoryWithdrawalThresholdMinorUnits: '50000000', // ₦500,000
    requireVerificationForCallouts: true,
    allowedCountries: ['NG']
  }
});

/**
 * Server-authoritative domain detection:
 * Inspects changes between candidate payload and base payload, returning
 * an array of all modified domain names.
 *
 * @param {object} newPayload
 * @param {object} [basePayload]
 * @returns {string[]} Array of modified domain names
 */
export function detectModifiedDomains(newPayload, basePayload = DEFAULT_CONFIG_PAYLOAD) {
  if (!basePayload) {
    return Object.values(CONFIG_DOMAINS);
  }

  const modified = [];

  if (JSON.stringify(newPayload.platform) !== JSON.stringify(basePayload.platform)) {
    modified.push(CONFIG_DOMAINS.PLATFORM);
  }
  if (JSON.stringify(newPayload.financial) !== JSON.stringify(basePayload.financial)) {
    modified.push(CONFIG_DOMAINS.FINANCIAL);
  }
  if (JSON.stringify(newPayload.tiers) !== JSON.stringify(basePayload.tiers)) {
    modified.push(CONFIG_DOMAINS.TIERS);
  }
  if (JSON.stringify(newPayload.game) !== JSON.stringify(basePayload.game)) {
    modified.push(CONFIG_DOMAINS.GAME);
  }
  if (JSON.stringify(newPayload.matchmaking) !== JSON.stringify(basePayload.matchmaking)) {
    modified.push(CONFIG_DOMAINS.MATCHMAKING);
  }
  if (JSON.stringify(newPayload.saferPlay) !== JSON.stringify(basePayload.saferPlay)) {
    modified.push(CONFIG_DOMAINS.SAFER_PLAY);
  }
  if (JSON.stringify(newPayload.kyc) !== JSON.stringify(basePayload.kyc)) {
    modified.push(CONFIG_DOMAINS.KYC);
  }

  return modified;
}

/**
 * Determines whether the set of modified domains requires Maker-Checker dual control.
 *
 * @param {string[]} domains
 * @returns {boolean}
 */
export function isRestrictedDomains(domains) {
  if (!Array.isArray(domains) || domains.length === 0) return false;
  return domains.some((d) => RESTRICTED_DOMAINS.includes(d));
}

/**
 * Backward-compatible helper: checks whether proposed payload touches restricted areas.
 *
 * @param {object} newPayload
 * @param {object} [basePayload]
 * @returns {boolean}
 */
export function isRestrictedChange(newPayload, basePayload = DEFAULT_CONFIG_PAYLOAD) {
  const modified = detectModifiedDomains(newPayload, basePayload);
  return isRestrictedDomains(modified);
}
