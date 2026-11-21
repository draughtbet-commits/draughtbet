import crypto from 'node:crypto';
import { getMfaEncryptionKey } from './secrets.js';

// AES-256-GCM encryption for TOTP secrets & hashed recovery metadata at rest
// (admin MFA). A DB leak cannot mint valid codes because plaintext secrets are
// never stored. The 32-byte key is resolved via getMfaEncryptionKey(), which
// fails closed in production if ADMIN_MFA_SECRET_KEY is missing, weak, or
// malformed.

const IV_LENGTH = 12;

export const encryptMfaSecret = (plainText) => {
  if (typeof plainText !== 'string' || plainText.length === 0) {
    throw new Error('Cannot encrypt empty MFA secret payload');
  }
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', getMfaEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((b) => b.toString('base64')).join('.');
};

export const decryptMfaSecret = (payload) => {
  if (typeof payload !== 'string') {
    throw new Error('Invalid encrypted MFA secret payload');
  }
  const parts = payload.split('.');
  if (parts.length !== 3 || parts.some((p) => !p)) {
    throw new Error('Malformed encrypted MFA secret envelope');
  }
  const [ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getMfaEncryptionKey(),
    Buffer.from(ivB64, 'base64')
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final()
  ]).toString('utf8');
};
