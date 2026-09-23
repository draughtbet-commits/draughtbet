import crypto from 'node:crypto';
import prisma from '../../utils/db.js';
import logger from '../../utils/logger.js';

/**
 * DevicePushToken — server-side token registry for push delivery. The raw token
 * is never stored: only a sha256(tokens) hash (lookup + uniqueness) and an
 * AES-256-GCM ciphertext (recovery for the upstream push sender) are persisted.
 * The encryption key must be a 32-byte hex string in PUSH_TOKEN_ENCRYPTION_KEY.
 */

export class PushTokenError extends Error {
  constructor(message = 'Could not register the push token') {
    super(message);
    this.name = 'PushTokenError';
  }
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const PLATFORMS = Object.freeze(['ios', 'android', 'web']);

const keyFromEnv = () => {
  const hex = process.env.PUSH_TOKEN_ENCRYPTION_KEY ?? '';
  if (!SHA256_HEX.test(hex)) {
    throw new PushTokenError('PUSH_TOKEN_ENCRYPTION_KEY must be a 32-byte hex string');
  }
  return Buffer.from(hex, 'hex');
};

const sha256Hex = (token) => crypto.createHash('sha256').update(token, 'utf8').digest('hex');

const encryptToken = (token) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFromEnv(), iv);
  const ct = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
};

export const decryptToken = (ciphertext, encryptionKeyHex) => {
  const raw = Buffer.from(ciphertext, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const key = SHA256_HEX.test(encryptionKeyHex ?? '')
    ? Buffer.from(encryptionKeyHex, 'hex')
    : keyFromEnv();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
};

const toView = (row) => ({
  id: row.id,
  platform: row.platform,
  active: row.active,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  revokedAt: row.revokedAt
});

/**
 * Registers a device push token. Re-registration of the same token reactivates
 * the existing row (idempotent); a token seen on a different account is still
 * tagged to its rightful owner and never exposed.
 */
export const registerPushToken = async (
  userId,
  { token, platform, deviceId = null },
  { dbp = prisma } = {}
) => {
  if (typeof token !== 'string' || !token.trim() || token.length > 4096) {
    throw new PushTokenError('Invalid push token');
  }
  if (!PLATFORMS.includes(platform)) {
    throw new PushTokenError(`Unsupported platform`);
  }

  const tokenHash = sha256Hex(token);
  const existing = await dbp.devicePushToken.findUnique({ where: { tokenHash } });

  if (existing && existing.userId === userId) {
    const updated = await dbp.devicePushToken.update({
      where: { id: existing.id },
      data: { active: true, revokedAt: null, platform, ...(deviceId ? { deviceId } : {}) }
    });
    return toView(updated);
  }

  const row = await dbp.devicePushToken.create({
    data: {
      userId,
      tokenHash,
      tokenCiphertext: encryptToken(token),
      platform,
      ...(deviceId ? { deviceId } : {})
    }
  });
  logger.info({ userId, platform }, 'Device push token registered');
  return toView(row);
};

/** Metadata view of the player's active push tokens (no ciphertext is echoed). */
export const listPushTokens = async (userId, { dbp = prisma } = {}) => {
  const rows = await dbp.devicePushToken.findMany({
    where: { userId, active: true },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      platform: true,
      active: true,
      createdAt: true,
      updatedAt: true,
      revokedAt: true
    }
  });
  return rows.map(toView);
};

/** Revokes one token, scoped to its owner. */
export const revokePushToken = async (userId, tokenId, { dbp = prisma } = {}) => {
  const { count } = await dbp.devicePushToken.updateMany({
    where: { id: tokenId, userId, active: true },
    data: { active: false, revokedAt: new Date() }
  });
  if (count === 0) throw new PushTokenError('Push token not found');
  return { revoked: true };
};

export default {
  registerPushToken,
  listPushTokens,
  revokePushToken,
  decryptToken,
  PushTokenError
};