import { jest } from '@jest/globals';
import { isEnabled, allFlags, __setFlags, __resetFlags } from '../featureFlags.js';

describe('feature flags', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    __resetFlags();
    delete process.env.FEATURE_LEDGER_V2_READS;
    delete process.env.FEATURE_MATCH_STATE_V2;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('defaults all known flags to off', () => {
    expect(Object.values(allFlags()).every((value) => value === false)).toBe(true);
  });

  it('enables a flag via FEATURE_<FLAG> env vars', () => {
    process.env.FEATURE_LEDGER_V2_READS = 'true';
    expect(isEnabled('LEDGER_V2_READS')).toBe(true);
    process.env.FEATURE_LEDGER_V2_READS = '1';
    expect(isEnabled('LEDGER_V2_READS')).toBe(true);
    process.env.FEATURE_LEDGER_V2_READS = '0';
    expect(isEnabled('LEDGER_V2_READS')).toBe(false);
  });

  it('normalizes flag names and ignores unsupported characters', () => {
    process.env.FEATURE_MATCH_STATE_V2 = 'true';
    expect(isEnabled('match-state_v2')).toBe(true);
  });

  it('favours test overrides over env vars', () => {
    process.env.FEATURE_LEDGER_V2_READS = 'true';
    __setFlags({ LEDGER_V2_READS: false });
    expect(isEnabled('LEDGER_V2_READS')).toBe(false);
  });
});