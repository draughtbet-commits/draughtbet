import crypto from 'node:crypto';
import { getJwtSecret, KNOWN_WEAK_JWT_SECRETS } from './jwtEnv.js';

const KNOWN_WEAK_SIGNING_SECRETS = new Set([
  ...KNOWN_WEAK_JWT_SECRETS,
  'kyc-ephemeral-signing-key',
  'your-mfa-secret-encryption-key-00000000000000000000000000000000',
  'test_mfa_key',
  'your-csrf-secret',
  'changeme',
  'secret',
  'default-secret'
]);

const MIN_PRODUCTION_SECRET_LENGTH = 32;

const deriveDomainSecret = (domain) => {
  const master = getJwtSecret();
  return crypto
    .createHmac('sha256', master)
    .update(`draughtbet:secret:v1:${domain}`)
    .digest('hex');
};

const validateConfiguredSecret = (name, value) => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    throw new Error(`FATAL: ${name} environment variable is empty.`);
  }
  if (process.env.NODE_ENV === 'production') {
    if (KNOWN_WEAK_SIGNING_SECRETS.has(trimmed)) {
      throw new Error(
        `FATAL: ${name} is a known sample or weak value. Refusing to start in production.`
      );
    }
    if (trimmed.length < MIN_PRODUCTION_SECRET_LENGTH) {
      throw new Error(
        `FATAL: ${name} must be at least ${MIN_PRODUCTION_SECRET_LENGTH} characters in production.`
      );
    }
  }
  return trimmed;
};

/**
 * Resolves the HMAC signing key for ephemeral KYC document access tokens.
 * Never falls back to a hardcoded string literal: uses KYC_DOCUMENT_SIGNING_SECRET
 * if explicitly configured, otherwise derives a domain-separated key from the
 * validated JWT_SECRET (which fails closed outside NODE_ENV=test).
 */
export const getKycDocumentSigningSecret = () => {
  if (process.env.KYC_DOCUMENT_SIGNING_SECRET !== undefined && process.env.KYC_DOCUMENT_SIGNING_SECRET !== '') {
    return validateConfiguredSecret(
      'KYC_DOCUMENT_SIGNING_SECRET',
      process.env.KYC_DOCUMENT_SIGNING_SECRET
    );
  }
  return deriveDomainSecret('kyc-document-access');
};

/**
 * Resolves the HMAC signing key for signed double-submit CSRF tokens.
 * Never falls back to a hardcoded string literal.
 */
export const getCsrfSecret = () => {
  if (process.env.CSRF_SECRET !== undefined && process.env.CSRF_SECRET !== '') {
    return validateConfiguredSecret('CSRF_SECRET', process.env.CSRF_SECRET);
  }
  return deriveDomainSecret('admin-csrf-token');
};

/**
 * Resolves and validates ADMIN_MFA_SECRET_KEY (32-byte / 64-char hex).
 * Production MUST provide an explicit non-sample key; non-production fails
 * closed if an invalid value is supplied and otherwise derives from validated
 * JWT_SECRET (never a hardcoded string outside test).
 */
export const getMfaEncryptionKey = () => {
  const raw = process.env.ADMIN_MFA_SECRET_KEY;
  if (raw !== undefined && raw !== '') {
    if (process.env.NODE_ENV === 'production' && KNOWN_WEAK_SIGNING_SECRETS.has(raw)) {
      throw new Error(
        'FATAL: ADMIN_MFA_SECRET_KEY is a known sample value. Refusing to start in production.'
      );
    }
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
      throw new Error('FATAL: ADMIN_MFA_SECRET_KEY must be a 64-char hex string (32 bytes).');
    }
    return Buffer.from(raw, 'hex');
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'FATAL: ADMIN_MFA_SECRET_KEY is missing. It is required to encrypt admin MFA secrets at rest.'
    );
  }

  // Non-production fallback derives from validated JWT_SECRET (which throws in
  // development if JWT_SECRET is missing — never uses a hardcoded fallback key).
  return crypto
    .createHmac('sha256', getJwtSecret())
    .update('draughtbet:secret:v1:admin-mfa-encryption')
    .digest();
};

/**
 * Startup fail-closed check for required cryptographic secrets and security
 * configuration. Invoked on app/server boot outside NODE_ENV=test.
 */
export const assertStartupSecrets = () => {
  if (process.env.NODE_ENV === 'test') {
    return { ok: true, mode: 'test' };
  }

  // 1. JWT signing key (must exist in dev & prod; strong + non-sample in prod)
  getJwtSecret();

  // 2. MFA at-rest encryption key (required & 64-char hex in prod; validated if set in dev)
  getMfaEncryptionKey();

  // 3. Derived/explicit KYC document access & CSRF signing keys
  getKycDocumentSigningSecret();
  getCsrfSecret();

  // 4. Production CORS guard (no wildcard with credentials)
  if (process.env.NODE_ENV === 'production') {
    const corsOrigin = (process.env.ADMIN_CORS_ORIGIN || '').trim();
    if (!corsOrigin) {
      throw new Error('FATAL: ADMIN_CORS_ORIGIN is missing. Refusing to start with open CORS.');
    }
    const origins = corsOrigin.split(',').map((o) => o.trim()).filter(Boolean);
    if (origins.length === 0 || origins.includes('*')) {
      throw new Error('FATAL: ADMIN_CORS_ORIGIN cannot be empty or contain wildcard "*" in production.');
    }
  }

  return { ok: true, mode: process.env.NODE_ENV || 'development' };
};
