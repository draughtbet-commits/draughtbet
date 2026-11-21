import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { getJwtSecret } from '../jwtEnv.js';
import {
  getKycDocumentSigningSecret,
  getCsrfSecret,
  getMfaEncryptionKey,
  assertStartupSecrets
} from '../secrets.js';
import { encryptMfaSecret, decryptMfaSecret } from '../mfaSecrets.js';
import { createPaystackMockSignature } from '../../simulation/simGuard.js';

describe('Cryptographic Secrets & Fail-Closed Startup Guards', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...savedEnv };
    delete process.env.JWT_SECRET;
    delete process.env.ADMIN_MFA_SECRET_KEY;
    delete process.env.KYC_DOCUMENT_SIGNING_SECRET;
    delete process.env.CSRF_SECRET;
    delete process.env.ADMIN_CORS_ORIGIN;
    delete process.env.PAYSTACK_SECRET_KEY;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('fails closed in production and development when JWT_SECRET is missing', () => {
    process.env.NODE_ENV = 'production';
    expect(() => getJwtSecret()).toThrow(/JWT_SECRET environment variable is missing/);

    process.env.NODE_ENV = 'development';
    expect(() => getJwtSecret()).toThrow(/JWT_SECRET environment variable is missing/);
  });

  it('rejects short or known sample JWT secrets in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'short-secret-123';
    expect(() => getJwtSecret()).toThrow(/at least 32 characters/);

    process.env.JWT_SECRET = 'your-super-secret-jwt-key';
    expect(() => getJwtSecret()).toThrow(/known sample value/);
  });

  it('never falls back to hardcoded kyc-ephemeral-signing-key and fails closed when secrets missing', () => {
    process.env.NODE_ENV = 'production';
    expect(() => getKycDocumentSigningSecret()).toThrow(/JWT_SECRET/);

    process.env.KYC_DOCUMENT_SIGNING_SECRET = 'kyc-ephemeral-signing-key';
    expect(() => getKycDocumentSigningSecret()).toThrow(/known sample or weak value/);

    process.env.JWT_SECRET = 'a'.repeat(64);
    delete process.env.KYC_DOCUMENT_SIGNING_SECRET;
    const derived = getKycDocumentSigningSecret();
    expect(derived).toHaveLength(64);
    expect(derived).not.toBe('kyc-ephemeral-signing-key');
    expect(derived).not.toBe(process.env.JWT_SECRET);
  });

  it('enforces dedicated 64-char hex ADMIN_MFA_SECRET_KEY in production and authenticates AES-256-GCM', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'j'.repeat(64);

    expect(() => getMfaEncryptionKey()).toThrow(/ADMIN_MFA_SECRET_KEY is missing/);

    process.env.ADMIN_MFA_SECRET_KEY = 'your-mfa-secret-encryption-key-00000000000000000000000000000000';
    expect(() => getMfaEncryptionKey()).toThrow(/known sample value/);

    process.env.ADMIN_MFA_SECRET_KEY = 'not-hex';
    expect(() => getMfaEncryptionKey()).toThrow(/64-char hex/);

    process.env.ADMIN_MFA_SECRET_KEY = '0123456789abcdef'.repeat(4);
    const enc = encryptMfaSecret('JBSWY3DPEHPK3PXP');
    expect(enc.split('.')).toHaveLength(3);
    expect(enc).not.toContain('JBSWY3DPEHPK3PXP');
    expect(decryptMfaSecret(enc)).toBe('JBSWY3DPEHPK3PXP');

    // Tampered ciphertext must fail authentication tag verification
    const [iv, tag, data] = enc.split('.');
    const tampered = [iv, tag, Buffer.from('tampered').toString('base64')].join('.');
    expect(() => decryptMfaSecret(tampered)).toThrow();
  });

  it('validates all required startup secrets and rejects wildcard CORS in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'j'.repeat(64);
    process.env.ADMIN_MFA_SECRET_KEY = 'f'.repeat(64);
    process.env.ADMIN_CORS_ORIGIN = '*';

    expect(() => assertStartupSecrets()).toThrow(/wildcard/);

    process.env.ADMIN_CORS_ORIGIN = 'https://admin.draughtbet.com';
    expect(assertStartupSecrets()).toEqual({ ok: true, mode: 'production' });
  });

  it('rejects missing CSRF secret outside test and empty Paystack mock signature key', () => {
    process.env.NODE_ENV = 'production';
    expect(() => getCsrfSecret()).toThrow(/JWT_SECRET/);

    process.env.CSRF_SECRET = 'changeme';
    expect(() => getCsrfSecret()).toThrow(/known sample or weak value/);

    expect(() => createPaystackMockSignature('{}')).toThrow(/PAYSTACK_SECRET_KEY is required/);
  });
});
