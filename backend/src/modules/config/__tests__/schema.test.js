import {
  PlatformConfigPayloadSchema,
  DEFAULT_CONFIG_PAYLOAD,
  detectModifiedDomains,
  isRestrictedDomains,
  isRestrictedChange,
  CONFIG_DOMAINS
} from '../schema.js';

describe('PlatformConfig schema and validation', () => {
  it('validates the default canonical configuration successfully', () => {
    const parseResult = PlatformConfigPayloadSchema.safeParse(DEFAULT_CONFIG_PAYLOAD);
    expect(parseResult.success).toBe(true);
  });

  it('rejects floating point values in minor units', () => {
    const invalid = structuredClone(DEFAULT_CONFIG_PAYLOAD);
    invalid.financial.minDepositMinorUnits = '1000.50';

    const parseResult = PlatformConfigPayloadSchema.safeParse(invalid);
    expect(parseResult.success).toBe(false);
    expect(parseResult.error.issues[0].message).toMatch(/minor units/);
  });

  it('rejects negative numbers in minor units', () => {
    const invalid = structuredClone(DEFAULT_CONFIG_PAYLOAD);
    invalid.financial.minDepositMinorUnits = '-5000';

    const parseResult = PlatformConfigPayloadSchema.safeParse(invalid);
    expect(parseResult.success).toBe(false);
  });

  it('rejects minDeposit exceeding maxDeposit', () => {
    const invalid = structuredClone(DEFAULT_CONFIG_PAYLOAD);
    invalid.financial.minDepositMinorUnits = '50000001';
    invalid.financial.maxDepositMinorUnits = '50000000';

    const parseResult = PlatformConfigPayloadSchema.safeParse(invalid);
    expect(parseResult.success).toBe(false);
    expect(parseResult.error.issues.some((i) => i.path.includes('minDepositMinorUnits'))).toBe(true);
  });

  it('rejects minWithdrawal exceeding maxWithdrawal', () => {
    const invalid = structuredClone(DEFAULT_CONFIG_PAYLOAD);
    invalid.financial.minWithdrawalMinorUnits = '100000001';
    invalid.financial.maxWithdrawalMinorUnits = '100000000';

    const parseResult = PlatformConfigPayloadSchema.safeParse(invalid);
    expect(parseResult.success).toBe(false);
    expect(parseResult.error.issues.some((i) => i.path.includes('minWithdrawalMinorUnits'))).toBe(true);
  });

  it('validates KYC threshold independently of minimum withdrawal', () => {
    // Both settings possess independent business meanings:
    // Mandatory KYC can be 0 (all withdrawals need KYC) or lower than minWithdrawal
    const validIndependent = structuredClone(DEFAULT_CONFIG_PAYLOAD);
    validIndependent.financial.minWithdrawalMinorUnits = '500000'; // ₦5,000
    validIndependent.kyc.mandatoryWithdrawalThresholdMinorUnits = '0'; // ₦0 (KYC required for all)

    const parseResult = PlatformConfigPayloadSchema.safeParse(validIndependent);
    expect(parseResult.success).toBe(true);
  });

  it('allows overlapping tier ranges while enforcing monotonic progression', () => {
    // Default config has overlapping AMATEUR (₦500 - ₦15,000) and MASTER (₦10,000 - ₦30,000)
    expect(PlatformConfigPayloadSchema.safeParse(DEFAULT_CONFIG_PAYLOAD).success).toBe(true);

    // 1. Min >= Max within tier rejected
    const invalid1 = structuredClone(DEFAULT_CONFIG_PAYLOAD);
    invalid1.tiers.AMATEUR.minStake = '2000000';
    invalid1.tiers.AMATEUR.maxStake = '1500000';
    expect(PlatformConfigPayloadSchema.safeParse(invalid1).success).toBe(false);

    // 2. Non-monotonic tier ranges (AMATEUR max > MASTER max) rejected
    const invalid2 = structuredClone(DEFAULT_CONFIG_PAYLOAD);
    invalid2.tiers.AMATEUR.maxStake = '4000000';
    invalid2.tiers.MASTER.maxStake = '3000000';
    expect(PlatformConfigPayloadSchema.safeParse(invalid2).success).toBe(false);

    // 3. Non-monotonic tier minimums (AMATEUR min > MASTER min) rejected
    const invalid3 = structuredClone(DEFAULT_CONFIG_PAYLOAD);
    invalid3.tiers.AMATEUR.minStake = '1200000';
    invalid3.tiers.MASTER.minStake = '1000000';
    expect(PlatformConfigPayloadSchema.safeParse(invalid3).success).toBe(false);
  });

  it('accurately detects modified domains and restricted status', () => {
    const base = structuredClone(DEFAULT_CONFIG_PAYLOAD);

    // 1. Financial modification -> FINANCIAL domain, restricted
    const finChange = structuredClone(base);
    finChange.financial.commissionPercent = 12;
    const finDomains = detectModifiedDomains(finChange, base);
    expect(finDomains).toEqual([CONFIG_DOMAINS.FINANCIAL]);
    expect(isRestrictedDomains(finDomains)).toBe(true);
    expect(isRestrictedChange(finChange, base)).toBe(true);

    // 2. Multi-domain modification (Game + Platform) -> non-restricted
    const multiUnrestricted = structuredClone(base);
    multiUnrestricted.platform.supportEmail = 'ops@draughtbet.com';
    multiUnrestricted.game.timeControlSeconds = 45;
    const multiDomains = detectModifiedDomains(multiUnrestricted, base);
    expect(multiDomains).toContain(CONFIG_DOMAINS.PLATFORM);
    expect(multiDomains).toContain(CONFIG_DOMAINS.GAME);
    expect(isRestrictedDomains(multiDomains)).toBe(false);

    // 3. Multi-domain modification (Game + Tiers) -> restricted because Tiers is restricted
    const multiRestricted = structuredClone(base);
    multiRestricted.game.timeControlSeconds = 45;
    multiRestricted.tiers.AMATEUR.maxStake = '1200000';
    const multiRestrictedDomains = detectModifiedDomains(multiRestricted, base);
    expect(multiRestrictedDomains).toContain(CONFIG_DOMAINS.GAME);
    expect(multiRestrictedDomains).toContain(CONFIG_DOMAINS.TIERS);
    expect(isRestrictedDomains(multiRestrictedDomains)).toBe(true);
  });
});
