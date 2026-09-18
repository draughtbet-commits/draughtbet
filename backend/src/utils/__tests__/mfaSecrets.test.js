import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { encryptMfaSecret, decryptMfaSecret } from '../mfaSecrets.js';

describe('mfaSecrets', () => {
  const originalEnv = process.env;
  const KEY = '1'.repeat(64);

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.ADMIN_MFA_SECRET_KEY = KEY;
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('round-trips a base32 secret', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const enc = encryptMfaSecret(secret);
    expect(enc).not.toContain(secret);
    expect(decryptMfaSecret(enc)).toBe(secret);
  });

  it('produces a unique ciphertext per call', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    expect(encryptMfaSecret(secret)).not.toBe(encryptMfaSecret(secret));
  });

  it('fails to decrypt with a different key', () => {
    const enc = encryptMfaSecret('secret');
    process.env.ADMIN_MFA_SECRET_KEY = '2'.repeat(64);
    expect(() => decryptMfaSecret(enc)).toThrow();
  });

  it('refuses a non-32-byte key', () => {
    process.env.ADMIN_MFA_SECRET_KEY = 'abcd';
    expect(() => encryptMfaSecret('x')).toThrow(/64-char hex/);
  });

  it('refuses to run in production without a dedicated key', () => {
    delete process.env.ADMIN_MFA_SECRET_KEY;
    process.env.NODE_ENV = 'production';
    expect(() => encryptMfaSecret('x')).toThrow(/ADMIN_MFA_SECRET_KEY is missing/);
  });

  it('refuses a known sample key in production', () => {
    process.env.ADMIN_MFA_SECRET_KEY = 'your-mfa-secret-encryption-key-00000000000000000000000000000000';
    process.env.NODE_ENV = 'production';
    expect(() => encryptMfaSecret('x')).toThrow(/sample value/);
  });

  it('derives a deterministic dev key when unset outside production', () => {
    delete process.env.ADMIN_MFA_SECRET_KEY;
    process.env.NODE_ENV = 'test';
    const enc = encryptMfaSecret('s');
    expect(decryptMfaSecret(enc)).toBe('s');
  });
});