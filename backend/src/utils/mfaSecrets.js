import crypto from 'crypto';

// AES-256-GCM encryption for TOTP secrets at rest (admin MFA). A DB leak must
// not mint valid codes, so the base32 secret is never stored in the clear. The
// key comes from ADMIN_MFA_SECRET_KEY (32+ bytes hex); in non-production it
// falls back to a key derived from JWT_SECRET so dev/test work without an extra
// env, and production refuses to boot without the dedicated key.

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

// Does the configured key look deliberately set (not the documented sample)?
const SAMPLE_SECRET_KEYS = new Set([
  'your-mfa-secret-encryption-key-00000000000000000000000000000000',
  'test_mfa_key'
]);

const resolveKey = () => {
  const raw = process.env.ADMIN_MFA_SECRET_KEY;
  if (raw) {
    if (process.env.NODE_ENV === 'production' && SAMPLE_SECRET_KEYS.has(raw)) {
      throw new Error('FATAL: ADMIN_MFA_SECRET_KEY is a known sample value. Refusing to start in production.');
    }
    const key = Buffer.from(raw, 'hex');
    if (key.length !== 32) {
      throw new Error('FATAL: ADMIN_MFA_SECRET_KEY must be a 64-char hex string (32 bytes).');
    }
    return key;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('FATAL: ADMIN_MFA_SECRET_KEY is missing. It is required to encrypt admin MFA secrets at rest.');
  }
  return crypto.createHash('sha256').update(process.env.JWT_SECRET || 'test_secret').digest();
};

export const encryptMfaSecret = (plainSecret) => {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', resolveKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainSecret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((b) => b.toString('base64')).join('.');
};

export const decryptMfaSecret = (payload) => {
  const [ivB64, tagB64, dataB64] = payload.split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', resolveKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
};