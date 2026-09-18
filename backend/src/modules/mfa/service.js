import { generateSecret, generateURI, verifySync } from 'otplib';
import prisma from '../../utils/db.js';
import redis from '../../utils/redis.js';
import logger from '../../utils/logger.js';
import { encryptMfaSecret, decryptMfaSecret } from '../../utils/mfaSecrets.js';

// RFC-6238 TOTP for admin MFA. Secret stored encrypted at rest (AdminMfa.secretEnc).
// ±30s clock window (one time step either side) is the verification tolerance.

export class AdminMfaNotFoundError extends Error {
  constructor(message = 'Admin MFA is not provisioned') {
    super(message);
    this.name = 'AdminMfaNotFoundError';
  }
}

export class AdminMfaStateError extends Error {
  constructor(message = 'Invalid admin MFA state') {
    super(message);
    this.name = 'AdminMfaStateError';
  }
}

export class AdminMfaCodeError extends Error {
  constructor(message = 'Invalid admin MFA code') {
    super(message);
    this.name = 'AdminMfaCodeError';
  }
}

export const MFA_FAIL_LIMIT = 5;
const MFA_FAIL_WINDOW_SECONDS = 600;

export const mfaStatusView = (row) => ({
  provisioned: Boolean(row),
  enabled: Boolean(row?.enabledAt && row.enabledAt.getTime() > 0)
});

export const getAdminMfaStatus = async (userId, { dbp = prisma } = {}) => {
  const row = await dbp.adminMfa.findUnique({ where: { userId } });
  return mfaStatusView(row);
};

/**
 * Provisions a fresh TOTP secret for an admin. The plaintext base32 + otpauth
 * URL are returned exactly once so ops can scan them into an authenticator
 * app; only the ciphertext is persisted. A second call for an already-enabled
 * admin re-rolls the secret (old codes die immediately) — caller should clear
 * any bootstrap UI afterwards.
 */
export const provisionAdminMfa = async (
  userId,
  { issuer = 'Draught Bet Admin', accountName = null, dbp = prisma } = {}
) => {
  const user = await dbp.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!user) throw new AdminMfaNotFoundError('Admin account not found');
  const secret = generateSecret();
  const label = accountName || user.email || userId;
  const existing = await dbp.adminMfa.findUnique({ where: { userId } });
  await dbp.adminMfa.upsert({
    where: { userId },
    create: {
      userId,
      secretEnc: encryptMfaSecret(secret),
      enabledAt: existing?.enabledAt ?? new Date(0)
    },
    update: { secretEnc: encryptMfaSecret(secret) }
  });
  return {
    base32: secret,
    otpauthUrl: generateURI({ issuer, label, secret })
  };
};

/**
 * Activate a just-provisioned secret (enabledAt currently epoch) once the
 * admin has proven they hold it in their authenticator app.
 */
export const enableAdminMfa = async (userId, code, { dbp = prisma } = {}) => {
  const row = await dbp.adminMfa.findUnique({ where: { userId } });
  if (!row) throw new AdminMfaNotFoundError();
  if (row.enabledAt && row.enabledAt.getTime() > 0) {
    throw new AdminMfaStateError('Admin MFA is already enabled');
  }
  if (!verifyCode(row, code)) throw new AdminMfaCodeError();
  return dbp.adminMfa.update({
    where: { userId },
    data: { enabledAt: new Date(), lastVerifiedAt: new Date() }
  });
};

export const disableAdminMfa = async (userId, code, { dbp = prisma } = {}) => {
  const row = await dbp.adminMfa.findUnique({ where: { userId } });
  if (!row) throw new AdminMfaNotFoundError();
  if (!verifyCode(row, code)) throw new AdminMfaCodeError();
  await dbp.adminMfa.delete({ where: { userId } });
  await revokeMfaFailedCount(userId);
  return true;
};

// Timing-safe TOTP check with ±1 step skew, reusing the same code a second
// time within its window is allowed (no single-code reuse cache).
const verifyCode = (row, code) => {
  if (typeof code !== 'string' || !code) return false;
  try {
    return verifySync({ secret: decryptMfaSecret(row.secretEnc), token: code, epochTolerance: 30 }).valid === true;
  } catch (err) {
    logger.warn({ err: err.message }, 'Admin MFA secret could not be decrypted');
    return false;
  }
};

export const verifyAdminMfaCode = async (userId, code, { dbp = prisma } = {}) => {
  const row = await dbp.adminMfa.findUnique({ where: { userId } });
  if (!row) return false;
  const ok = verifyCode(row, code);
  if (ok) {
    await revokeMfaFailedCount(userId);
    await dbp.adminMfa.update({
      where: { userId },
      data: { lastVerifiedAt: new Date() }
    });
  }
  return ok;
};

// Brute-force throttle: N consecutive wrong codes within a short window lock
// that admin's MFA for the remainder of the window (belt-and-braces on top of
// the route-level IP limiter). Degrades to no-lock when Redis is unavailable.
const failKey = (userId) => `mfa:fail:${userId}`;

export const isMfaLocked = async (userId) => {
  if (!redis) return false;
  const count = await redis.get(failKey(userId));
  return Number(count ?? 0) >= MFA_FAIL_LIMIT;
};

export const recordMfaFailure = async (userId) => {
  if (!redis) return;
  const key = failKey(userId);
  const ttl = await redis.ttl(key);
  await redis.incr(key);
  if (ttl < 0) await redis.expire(key, MFA_FAIL_WINDOW_SECONDS);
};

export const revokeMfaFailedCount = async (userId) => {
  if (!redis) return;
  await redis.del(failKey(userId));
};

export const AdminMfaService = Object.freeze({
  getStatus: getAdminMfaStatus,
  provision: provisionAdminMfa,
  enable: enableAdminMfa,
  disable: disableAdminMfa,
  verify: verifyAdminMfaCode,
  isLocked: isMfaLocked,
  recordFailure: recordMfaFailure,
  clearFailures: revokeMfaFailedCount
});