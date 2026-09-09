// Feature flag infrastructure for the V2 migration (see Repo Remediation Plan PR 0).
// Flags are disabled by default and enabled via FEATURE_<FLAG> env vars,
// or overridden in tests via __setFlags to match the AuthService.__setPrisma pattern.

const KNOWN_FLAGS = Object.freeze({
  LEDGER_V2_READS: false,
  MATCH_STATE_V2: false,
  SETTLEMENT_V2: false,
  DEPOSIT_V2: false,
  WITHDRAWAL_V2: false,
  KYC_V2: false,
  ADMIN_V2: false,
  OUTBOX_V2: false
});

const overrides = {};

export const isEnabled = (flag) => {
  const name = String(flag).toUpperCase()
    .replace(/-/g, '_')
    .replace(/[^A-Z0-9_]/g, '');
  if (Object.prototype.hasOwnProperty.call(overrides, name)) {
    return Boolean(overrides[name]);
  }
  const envValue = process.env[`FEATURE_${name}`];
  return envValue === 'true' || envValue === '1';
};

export const allFlags = () => ({ ...KNOWN_FLAGS });

// Test seam: mirrors the __setPrisma pattern used by AuthService.
export const __setFlags = (flags) => Object.assign(overrides, flags);

export const __resetFlags = () => {
  for (const key of Object.keys(overrides)) delete overrides[key];
};