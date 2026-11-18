import type { ConfigDomainName, PlatformConfigPayload } from '../api/types';
import { formatNaira } from '../utils';

export const RESTRICTED_DOMAINS: readonly ConfigDomainName[] = [
  'FINANCIAL',
  'TIERS',
  'SAFER_PLAY',
  'KYC'
] as const;

export const DEFAULT_CONFIG_PAYLOAD: PlatformConfigPayload = {
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
    minDepositMinorUnits: '100000', // ₦1,000.00
    maxDepositMinorUnits: '50000000', // ₦500,000.00
    minWithdrawalMinorUnits: '200000', // ₦2,000.00
    maxWithdrawalMinorUnits: '100000000', // ₦1,000,000.00
    dailyWithdrawalCeilingMinorUnits: '500000000' // ₦5,000,000.00
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
    mandatoryWithdrawalThresholdMinorUnits: '50000000', // ₦500,000.00
    requireVerificationForCallouts: true,
    allowedCountries: ['NG']
  }
};

export interface DomainMetadata {
  domain: ConfigDomainName;
  label: string;
  description: string;
  isRestricted: boolean;
  proposePermissionLabel: string;
  operationalImpact: string;
}

export const CONFIG_DOMAIN_METADATA: Record<ConfigDomainName, DomainMetadata> = {
  PLATFORM: {
    domain: 'PLATFORM',
    label: 'Platform Identity & Defaults',
    description: 'Core platform identity, canonical NGN currency settings, and operational support contact.',
    isRestricted: false,
    proposePermissionLabel: 'SUPER_ADMIN, FINANCE, GAME_OPERATIONS, or RISK_COMPLIANCE',
    operationalImpact: 'Applies immediately upon version activation across platform metadata.'
  },
  FINANCIAL: {
    domain: 'FINANCIAL',
    label: 'Financial Thresholds & Rake',
    description: 'Platform rake commission percentage and NGN deposit/withdrawal transaction limits (in kobo).',
    isRestricted: true,
    proposePermissionLabel: 'SUPER_ADMIN or FINANCE (Maker-Checker Required)',
    operationalImpact: 'New commission rates apply ONLY to newly funded matches; existing funded matches retain their frozen snapshot.'
  },
  TIERS: {
    domain: 'TIERS',
    label: 'Player Tier Stake & Call-Out Bands',
    description: 'Monotonic NGN stake boundaries and high-stakes call-out ceilings for Amateur, Master, and Pro tiers.',
    isRestricted: true,
    proposePermissionLabel: 'SUPER_ADMIN or FINANCE (Maker-Checker Required)',
    operationalImpact: 'Applies to new matchmaking queue entries and new call-out challenges. Active matches are unaffected.'
  },
  GAME: {
    domain: 'GAME',
    label: 'Game Engine & Match Timing',
    description: 'International Draughts ruleset version, per-turn clocks, readiness window, disconnect grace, and draw rules.',
    isRestricted: false,
    proposePermissionLabel: 'SUPER_ADMIN or GAME_OPERATIONS',
    operationalImpact: 'Applies to newly funded matches only. Funded matches snapshot timeControlSeconds and rulesetVersion.'
  },
  MATCHMAKING: {
    domain: 'MATCHMAKING',
    label: 'Matchmaking Queue & Worker',
    description: 'Queue expiration timeout, worker pairing tick interval, and per-player concurrency constraints.',
    isRestricted: false,
    proposePermissionLabel: 'SUPER_ADMIN or GAME_OPERATIONS',
    operationalImpact: 'Applies to live matchmaking queue sweeps upon activation.'
  },
  SAFER_PLAY: {
    domain: 'SAFER_PLAY',
    label: 'Safer-Play Policy Defaults',
    description: 'Mandatory cooling-off window for limit raises and minimum timeout/self-exclusion durations.',
    isRestricted: true,
    proposePermissionLabel: 'SUPER_ADMIN or RISK_COMPLIANCE (Maker-Checker Required)',
    operationalImpact: 'Governs new limit raise requests and minimum protection floors; never weakens active player exclusions.'
  },
  KYC: {
    domain: 'KYC',
    label: 'KYC & Regional Eligibility',
    description: 'Mandatory KYC withdrawal threshold, call-out verification requirement, and allowed ISO country codes.',
    isRestricted: true,
    proposePermissionLabel: 'SUPER_ADMIN or RISK_COMPLIANCE (Maker-Checker Required)',
    operationalImpact: 'Enforced on withdrawal requests, call-out creation/acceptance, and geo-eligibility checks.'
  }
};

/**
 * BigInt-safe helper: converts integer kobo string to Naira string (e.g., "100000" -> "1000").
 * Never uses floating-point arithmetic.
 */
export function koboToNairaInput(koboStr: string | null | undefined): string {
  if (!koboStr || !/^(0|[1-9]\d*)$/.test(String(koboStr).trim())) {
    return '0';
  }
  try {
    const kobo = BigInt(String(koboStr).trim());
    const naira = kobo / BigInt(100);
    const rem = kobo % BigInt(100);
    if (rem === BigInt(0)) {
      return naira.toString();
    }
    return `${naira.toString()}.${rem.toString().padStart(2, '0')}`;
  } catch {
    return '0';
  }
}

/**
 * BigInt-safe helper: converts a Naira string (whole Naira or up to 2 decimal places)
 * into a canonical integer kobo string without floating-point math.
 * Returns null if input is malformed.
 */
export function nairaInputToKobo(nairaStr: string): string | null {
  const trimmed = String(nairaStr ?? '').trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return null;
  }
  const [wholePart, fracPart = ''] = trimmed.split('.');
  const paddedFrac = fracPart.padEnd(2, '0').slice(0, 2);
  try {
    const kobo = BigInt(wholePart) * BigInt(100) + BigInt(paddedFrac);
    return kobo.toString();
  } catch {
    return null;
  }
}

/**
 * Formats kobo string with both Naira currency and explicit kobo minor units:
 * e.g. "₦1,000.00 (100,000 kobo)"
 */
export function formatNairaWithKobo(koboStr: string | number | bigint | null | undefined): string {
  if (koboStr === null || koboStr === undefined) return '₦0.00 (0 kobo)';
  const raw = String(koboStr).trim();
  if (!/^-?\d+$/.test(raw)) return String(koboStr);
  try {
    const formattedNaira = formatNaira(raw);
    const formattedKobo = BigInt(raw).toLocaleString('en-NG');
    return `${formattedNaira} (${formattedKobo} kobo)`;
  } catch {
    return String(koboStr);
  }
}

export type DiffStatus = 'CHANGED' | 'ADDED' | 'REMOVED' | 'UNCHANGED';

export interface ConfigFieldDiff {
  path: string;
  domain: ConfigDomainName;
  label: string;
  unit: 'kobo' | 'percent' | 'seconds' | 'ms' | 'hours' | 'minutes' | 'days' | 'text' | 'boolean' | 'list' | 'number';
  beforeValue: unknown;
  afterValue: unknown;
  beforeFormatted: string;
  afterFormatted: string;
  status: DiffStatus;
  isRestricted: boolean;
}

export interface DomainDiffGroup {
  domain: ConfigDomainName;
  metadata: DomainMetadata;
  fields: ConfigFieldDiff[];
  changedCount: number;
  addedCount: number;
  removedCount: number;
  unchangedCount: number;
}

export interface ConfigComparisonSummary {
  domains: DomainDiffGroup[];
  modifiedDomains: ConfigDomainName[];
  isRestricted: boolean;
  totalChanged: number;
  totalAdded: number;
  totalRemoved: number;
  totalUnchanged: number;
}

interface FieldDescriptor {
  path: string;
  domain: ConfigDomainName;
  label: string;
  unit: ConfigFieldDiff['unit'];
  get: (p: PlatformConfigPayload) => unknown;
}

const SENSITIVE_KEY_PATTERN = /secret|password|token|privateKey|apiKey/i;

export function formatConfigFieldValue(value: unknown, unit: ConfigFieldDiff['unit'], path = ''): string {
  if (SENSITIVE_KEY_PATTERN.test(path)) {
    return '[REDACTED]';
  }
  if (value === undefined || value === null) {
    return '—';
  }
  switch (unit) {
    case 'kobo':
      return formatNairaWithKobo(String(value));
    case 'percent':
      return `${String(value)}%`;
    case 'seconds':
      return `${String(value)}s`;
    case 'ms':
      return `${String(value)} ms (${Number(value) / 1000}s)`;
    case 'hours':
      return `${String(value)} hours`;
    case 'minutes':
      return `${String(value)} minutes`;
    case 'days':
      return `${String(value)} days`;
    case 'boolean':
      return value ? 'Enabled (true)' : 'Disabled (false)';
    case 'list':
      return Array.isArray(value) ? value.join(', ') || '(empty)' : String(value);
    default:
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
}

const CONFIG_FIELD_DESCRIPTORS: FieldDescriptor[] = [
  // PLATFORM
  {
    path: 'platform.identity',
    domain: 'PLATFORM',
    label: 'Platform Brand Identity',
    unit: 'text',
    get: (p) => p?.platform?.identity
  },
  {
    path: 'platform.defaultCurrency',
    domain: 'PLATFORM',
    label: 'Default Settlement Currency',
    unit: 'text',
    get: (p) => p?.platform?.defaultCurrency
  },
  {
    path: 'platform.supportedCurrencies',
    domain: 'PLATFORM',
    label: 'Supported Currencies',
    unit: 'list',
    get: (p) => p?.platform?.supportedCurrencies
  },
  {
    path: 'platform.supportEmail',
    domain: 'PLATFORM',
    label: 'Operational Support Email',
    unit: 'text',
    get: (p) => p?.platform?.supportEmail
  },
  {
    path: 'meta.environment',
    domain: 'PLATFORM',
    label: 'Target Environment Profile',
    unit: 'text',
    get: (p) => p?.meta?.environment
  },
  {
    path: 'meta.schemaVersion',
    domain: 'PLATFORM',
    label: 'Configuration Schema Version',
    unit: 'number',
    get: (p) => p?.meta?.schemaVersion
  },

  // FINANCIAL
  {
    path: 'financial.commissionPercent',
    domain: 'FINANCIAL',
    label: 'Platform Rake Commission',
    unit: 'percent',
    get: (p) => p?.financial?.commissionPercent
  },
  {
    path: 'financial.minDepositMinorUnits',
    domain: 'FINANCIAL',
    label: 'Minimum Deposit Threshold',
    unit: 'kobo',
    get: (p) => p?.financial?.minDepositMinorUnits
  },
  {
    path: 'financial.maxDepositMinorUnits',
    domain: 'FINANCIAL',
    label: 'Maximum Single Deposit Ceiling',
    unit: 'kobo',
    get: (p) => p?.financial?.maxDepositMinorUnits
  },
  {
    path: 'financial.minWithdrawalMinorUnits',
    domain: 'FINANCIAL',
    label: 'Minimum Withdrawal Threshold',
    unit: 'kobo',
    get: (p) => p?.financial?.minWithdrawalMinorUnits
  },
  {
    path: 'financial.maxWithdrawalMinorUnits',
    domain: 'FINANCIAL',
    label: 'Maximum Single Withdrawal Ceiling',
    unit: 'kobo',
    get: (p) => p?.financial?.maxWithdrawalMinorUnits
  },
  {
    path: 'financial.dailyWithdrawalCeilingMinorUnits',
    domain: 'FINANCIAL',
    label: 'Daily Aggregate Withdrawal Ceiling',
    unit: 'kobo',
    get: (p) => p?.financial?.dailyWithdrawalCeilingMinorUnits
  },

  // TIERS
  {
    path: 'tiers.AMATEUR.minStake',
    domain: 'TIERS',
    label: 'Amateur Tier — Minimum Stake',
    unit: 'kobo',
    get: (p) => p?.tiers?.AMATEUR?.minStake
  },
  {
    path: 'tiers.AMATEUR.maxStake',
    domain: 'TIERS',
    label: 'Amateur Tier — Maximum Stake',
    unit: 'kobo',
    get: (p) => p?.tiers?.AMATEUR?.maxStake
  },
  {
    path: 'tiers.AMATEUR.maxCallout',
    domain: 'TIERS',
    label: 'Amateur Tier — Call-Out Ceiling',
    unit: 'kobo',
    get: (p) => p?.tiers?.AMATEUR?.maxCallout
  },
  {
    path: 'tiers.MASTER.minStake',
    domain: 'TIERS',
    label: 'Master Tier — Minimum Stake',
    unit: 'kobo',
    get: (p) => p?.tiers?.MASTER?.minStake
  },
  {
    path: 'tiers.MASTER.maxStake',
    domain: 'TIERS',
    label: 'Master Tier — Maximum Stake',
    unit: 'kobo',
    get: (p) => p?.tiers?.MASTER?.maxStake
  },
  {
    path: 'tiers.MASTER.maxCallout',
    domain: 'TIERS',
    label: 'Master Tier — Call-Out Ceiling',
    unit: 'kobo',
    get: (p) => p?.tiers?.MASTER?.maxCallout
  },
  {
    path: 'tiers.PRO.minStake',
    domain: 'TIERS',
    label: 'Pro Tier — Minimum Stake',
    unit: 'kobo',
    get: (p) => p?.tiers?.PRO?.minStake
  },
  {
    path: 'tiers.PRO.maxStake',
    domain: 'TIERS',
    label: 'Pro Tier — Maximum Stake',
    unit: 'kobo',
    get: (p) => p?.tiers?.PRO?.maxStake
  },
  {
    path: 'tiers.PRO.maxCallout',
    domain: 'TIERS',
    label: 'Pro Tier — Call-Out Ceiling',
    unit: 'kobo',
    get: (p) => p?.tiers?.PRO?.maxCallout
  },

  // GAME
  {
    path: 'game.rulesetVersion',
    domain: 'GAME',
    label: 'International Draughts Ruleset Version',
    unit: 'number',
    get: (p) => p?.game?.rulesetVersion
  },
  {
    path: 'game.timeControlSeconds',
    domain: 'GAME',
    label: 'Per-Turn Time Control',
    unit: 'seconds',
    get: (p) => p?.game?.timeControlSeconds
  },
  {
    path: 'game.matchReadinessSeconds',
    domain: 'GAME',
    label: 'Match Readiness Confirmation Timeout',
    unit: 'seconds',
    get: (p) => p?.game?.matchReadinessSeconds
  },
  {
    path: 'game.disconnectGraceMs',
    domain: 'GAME',
    label: 'Disconnect Reconnection Grace Period',
    unit: 'ms',
    get: (p) => p?.game?.disconnectGraceMs
  },
  {
    path: 'game.maxConsecutiveKingMoves',
    domain: 'GAME',
    label: 'Automatic Draw — Max Consecutive King Moves',
    unit: 'number',
    get: (p) => p?.game?.maxConsecutiveKingMoves
  },
  {
    path: 'game.canOfferDrawPlyCount',
    domain: 'GAME',
    label: 'Minimum Ply Count Before Mutual Draw Offer',
    unit: 'number',
    get: (p) => p?.game?.canOfferDrawPlyCount
  },

  // MATCHMAKING
  {
    path: 'matchmaking.queueTimeoutSeconds',
    domain: 'MATCHMAKING',
    label: 'Queue Entry Expiration Timeout',
    unit: 'seconds',
    get: (p) => p?.matchmaking?.queueTimeoutSeconds
  },
  {
    path: 'matchmaking.cronTickSeconds',
    domain: 'MATCHMAKING',
    label: 'Matchmaking Worker Sweep Interval',
    unit: 'seconds',
    get: (p) => p?.matchmaking?.cronTickSeconds
  },
  {
    path: 'matchmaking.maxConcurrentQueuePerPlayer',
    domain: 'MATCHMAKING',
    label: 'Max Concurrent Queue Entries Per Player',
    unit: 'number',
    get: (p) => p?.matchmaking?.maxConcurrentQueuePerPlayer
  },

  // SAFER_PLAY
  {
    path: 'saferPlay.limitRaiseCoolingHours',
    domain: 'SAFER_PLAY',
    label: 'Limit Raise Mandatory Cooling-Off Period',
    unit: 'hours',
    get: (p) => p?.saferPlay?.limitRaiseCoolingHours
  },
  {
    path: 'saferPlay.minTimeoutDurationMinutes',
    domain: 'SAFER_PLAY',
    label: 'Minimum Player Timeout Break Duration',
    unit: 'minutes',
    get: (p) => p?.saferPlay?.minTimeoutDurationMinutes
  },
  {
    path: 'saferPlay.minSelfExclusionDays',
    domain: 'SAFER_PLAY',
    label: 'Minimum Hard Self-Exclusion Duration',
    unit: 'days',
    get: (p) => p?.saferPlay?.minSelfExclusionDays
  },

  // KYC
  {
    path: 'kyc.mandatoryWithdrawalThresholdMinorUnits',
    domain: 'KYC',
    label: 'Mandatory KYC Withdrawal Threshold',
    unit: 'kobo',
    get: (p) => p?.kyc?.mandatoryWithdrawalThresholdMinorUnits
  },
  {
    path: 'kyc.requireVerificationForCallouts',
    domain: 'KYC',
    label: 'Require Verified KYC for High-Stakes Call-Outs',
    unit: 'boolean',
    get: (p) => p?.kyc?.requireVerificationForCallouts
  },
  {
    path: 'kyc.allowedCountries',
    domain: 'KYC',
    label: 'Allowed Jurisdiction Country Codes (ISO-3166-1 alpha-2)',
    unit: 'list',
    get: (p) => p?.kyc?.allowedCountries
  }
];

/**
 * Computes a structured domain-by-domain comparison between two configuration payloads.
 */
export function computeConfigDiff(
  basePayload: PlatformConfigPayload | null | undefined,
  targetPayload: PlatformConfigPayload | null | undefined
): ConfigComparisonSummary {
  const base = basePayload ?? DEFAULT_CONFIG_PAYLOAD;
  const target = targetPayload ?? DEFAULT_CONFIG_PAYLOAD;

  const domainOrder: ConfigDomainName[] = [
    'PLATFORM',
    'FINANCIAL',
    'TIERS',
    'GAME',
    'MATCHMAKING',
    'SAFER_PLAY',
    'KYC'
  ];

  const domainGroupsMap = new Map<ConfigDomainName, DomainDiffGroup>();
  for (const dom of domainOrder) {
    domainGroupsMap.set(dom, {
      domain: dom,
      metadata: CONFIG_DOMAIN_METADATA[dom],
      fields: [],
      changedCount: 0,
      addedCount: 0,
      removedCount: 0,
      unchangedCount: 0
    });
  }

  let totalChanged = 0;
  let totalAdded = 0;
  let totalRemoved = 0;
  let totalUnchanged = 0;

  for (const desc of CONFIG_FIELD_DESCRIPTORS) {
    const beforeVal = desc.get(base);
    const afterVal = desc.get(target);
    const beforeJson = JSON.stringify(beforeVal);
    const afterJson = JSON.stringify(afterVal);

    let status: DiffStatus = 'UNCHANGED';
    if (beforeVal === undefined && afterVal !== undefined) {
      status = 'ADDED';
      totalAdded++;
    } else if (beforeVal !== undefined && afterVal === undefined) {
      status = 'REMOVED';
      totalRemoved++;
    } else if (beforeJson !== afterJson) {
      status = 'CHANGED';
      totalChanged++;
    } else {
      status = 'UNCHANGED';
      totalUnchanged++;
    }

    const group = domainGroupsMap.get(desc.domain)!;
    if (status === 'CHANGED') group.changedCount++;
    if (status === 'ADDED') group.addedCount++;
    if (status === 'REMOVED') group.removedCount++;
    if (status === 'UNCHANGED') group.unchangedCount++;

    group.fields.push({
      path: desc.path,
      domain: desc.domain,
      label: desc.label,
      unit: desc.unit,
      beforeValue: beforeVal,
      afterValue: afterVal,
      beforeFormatted: formatConfigFieldValue(beforeVal, desc.unit, desc.path),
      afterFormatted: formatConfigFieldValue(afterVal, desc.unit, desc.path),
      status,
      isRestricted: RESTRICTED_DOMAINS.includes(desc.domain)
    });
  }

  const domains = domainOrder.map((d) => domainGroupsMap.get(d)!);
  const modifiedDomains = domains
    .filter((g) => g.changedCount > 0 || g.addedCount > 0 || g.removedCount > 0)
    .map((g) => g.domain);

  const isRestricted = modifiedDomains.some((d) => RESTRICTED_DOMAINS.includes(d));

  return {
    domains,
    modifiedDomains,
    isRestricted,
    totalChanged,
    totalAdded,
    totalRemoved,
    totalUnchanged
  };
}
