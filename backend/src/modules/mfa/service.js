import crypto from 'node:crypto';
import prisma from '../../utils/db.js';
import redis, { isRedisReady } from '../../utils/redis.js';
import logger from '../../utils/logger.js';
import { encryptMfaSecret, decryptMfaSecret } from '../../utils/mfaSecrets.js';
import { getMfaEncryptionKey } from '../../utils/secrets.js';
import { generateBase32Secret, verifyTotp, generateOtpAuthUri } from '../../utils/totp.js';

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

export class AdminMfaLockedError extends Error {
  constructor(message = 'Too many failed admin MFA attempts. Try again later.') {
    super(message);
    this.name = 'AdminMfaLockedError';
  }
}

export const MFA_FAIL_LIMIT = 5;
const MFA_FAIL_WINDOW_SECONDS = 600;
const RECOVERY_CODE_COUNT = 8;

// In-process fallback failure tracker when Redis is unavailable so brute-force
// lockout never silently degrades to unlimited guesses.
const localMfaFailures = new Map();
const localUsedTotpSteps = new Map();

/**
 * Policy: MFA is enforced for all admins whenever ADMIN_MFA_ENFORCED=true,
 * or by default in production unless explicitly set to "false".
 */
export const isAdminMfaEnforced = () =>
  process.env.ADMIN_MFA_ENFORCED === 'true' ||
  (process.env.NODE_ENV === 'production' && process.env.ADMIN_MFA_ENFORCED !== 'false');

const normalizeRecoveryCode = (code) =>
  typeof code === 'string' ? code.trim().toUpperCase().replace(/[\s-]+/g, '') : '';

const hashRecoveryCode = (userId, normalizedCode) =>
  crypto
    .createHmac('sha256', getMfaEncryptionKey())
    .update(`mfa:recovery:v1:${userId}:${normalizedCode}`)
    .digest('hex');

const generateRecoveryCodePair = (userId, count = RECOVERY_CODE_COUNT) => {
  const plaintext = [];
  const entries = [];
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  for (let i = 0; i < count; i += 1) {
    const bytes = crypto.randomBytes(12);
    let raw = '';
    for (let j = 0; j < 12; j += 1) {
      raw += alphabet[bytes[j] % alphabet.length];
    }
    const formatted = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
    plaintext.push(formatted);
    entries.push({
      hash: hashRecoveryCode(userId, raw),
      used: false
    });
  }
  return { plaintext, entries };
};

const encodeStoredEnvelope = ({ secret, recoveryCodes = [] }) =>
  encryptMfaSecret(
    JSON.stringify({
      v: 2,
      secret,
      recoveryCodes
    })
  );

const decodeStoredEnvelope = (secretEnc) => {
  const plain = decryptMfaSecret(secretEnc);
  if (plain.startsWith('{')) {
    try {
      const parsed = JSON.parse(plain);
      if (parsed && typeof parsed.secret === 'string') {
        return {
          v: parsed.v || 2,
          secret: parsed.secret,
          recoveryCodes: Array.isArray(parsed.recoveryCodes) ? parsed.recoveryCodes : []
        };
      }
    } catch {
      // Fall through to legacy raw base32
    }
  }
  return { v: 1, secret: plain, recoveryCodes: [] };
};

export const mfaStatusView = (row) => ({
  provisioned: Boolean(row),
  enabled: Boolean(row?.enabledAt && row.enabledAt.getTime() > 0)
});

export const getAdminMfaStatus = async (userId, { dbp = prisma } = {}) => {
  const row = await dbp.adminMfa.findUnique({ where: { userId } });
  return mfaStatusView(row);
};

export const getAdminMfaDetailedStatus = async (userId, { dbp = prisma } = {}) => {
  const row = await dbp.adminMfa.findUnique({ where: { userId } });
  const base = mfaStatusView(row);
  let recoveryCodesRemaining = 0;
  if (row?.secretEnc) {
    try {
      const env = decodeStoredEnvelope(row.secretEnc);
      recoveryCodesRemaining = env.recoveryCodes.filter((c) => !c.used).length;
    } catch {
      recoveryCodesRemaining = 0;
    }
  }
  return {
    ...base,
    enforced: isAdminMfaEnforced(),
    enabledAt: base.enabled ? row.enabledAt : null,
    lastVerifiedAt: row?.lastVerifiedAt ?? null,
    recoveryCodesRemaining
  };
};

// ---------------------------------------------------------------------------
// Brute-force lockout & step replay protection
// ---------------------------------------------------------------------------

const failKey = (userId) => `mfa:fail:${userId}`;
const stepKey = (userId) => `mfa:laststep:${userId}`;

export const isMfaLocked = async (userId) => {
  if (redis && isRedisReady(redis)) {
    try {
      const count = await redis.get(failKey(userId));
      return Number(count ?? 0) >= MFA_FAIL_LIMIT;
    } catch {
      // Fall back to in-process lock map
    }
  } else if (redis && typeof redis.get === 'function' && process.env.NODE_ENV === 'test') {
    // Support unit tests that inject a mocked redis object without status === 'ready'
    try {
      const count = await redis.get(failKey(userId));
      if (count !== undefined && count !== null) {
        return Number(count) >= MFA_FAIL_LIMIT;
      }
    } catch {
      // Fall back to local map
    }
  }

  const local = localMfaFailures.get(userId);
  if (!local || local.expiresAt <= Date.now()) {
    localMfaFailures.delete(userId);
    return false;
  }
  return local.count >= MFA_FAIL_LIMIT;
};

export const recordMfaFailure = async (userId) => {
  const now = Date.now();
  const existing = localMfaFailures.get(userId);
  if (!existing || existing.expiresAt <= now) {
    localMfaFailures.set(userId, { count: 1, expiresAt: now + MFA_FAIL_WINDOW_SECONDS * 1000 });
  } else {
    existing.count += 1;
  }

  if (redis && (isRedisReady(redis) || (process.env.NODE_ENV === 'test' && typeof redis.incr === 'function'))) {
    try {
      const key = failKey(userId);
      const ttl = typeof redis.ttl === 'function' ? await redis.ttl(key) : -1;
      await redis.incr(key);
      if (ttl < 0 && typeof redis.expire === 'function') {
        await redis.expire(key, MFA_FAIL_WINDOW_SECONDS);
      }
    } catch (err) {
      logger.warn({ err: err.message, userId }, 'Redis MFA failure increment failed; local lock active');
    }
  }
};

export const revokeMfaFailedCount = async (userId) => {
  localMfaFailures.delete(userId);
  if (redis && (isRedisReady(redis) || (process.env.NODE_ENV === 'test' && typeof redis.del === 'function'))) {
    try {
      await redis.del(failKey(userId));
    } catch {
      // Best-effort clear
    }
  }
};

const consumeTotpStep = async (userId, step) => {
  if (step === null || step === undefined) return true;
  if (redis && isRedisReady(redis)) {
    try {
      const prev = await redis.get(stepKey(userId));
      if (prev !== null && Number(prev) >= step) {
        return false;
      }
      await redis.set(stepKey(userId), String(step), 'EX', 120);
      return true;
    } catch {
      // Fall through to local step guard
    }
  }
  const prevLocal = localUsedTotpSteps.get(userId);
  if (prevLocal !== undefined && prevLocal >= step) {
    return false;
  }
  localUsedTotpSteps.set(userId, step);
  return true;
};

export const clearLocalMfaState = () => {
  localMfaFailures.clear();
  localUsedTotpSteps.clear();
};

// ---------------------------------------------------------------------------
// Enrollment, Verification, Recovery & Disable
// ---------------------------------------------------------------------------

/**
 * Provisions a fresh TOTP secret + single-use recovery codes for an admin.
 * Plaintext base32, otpauthUrl, and recoveryCodes are returned ONCE; only the
 * AES-256-GCM ciphertext (containing the secret and HMAC-hashed recovery codes)
 * is persisted.
 *
 * Security invariant: if MFA is ALREADY enabled, callers MUST pass a valid
 * current TOTP code (`currentCode`) so an attacker with only a pre-MFA password
 * session can NEVER overwrite an enrolled admin's MFA secret.
 */
export const provisionAdminMfa = async (
  userId,
  {
    issuer = 'Draught Bet Admin',
    accountName = null,
    currentCode = null,
    allowOverwriteWithoutCode = false,
    dbp = prisma
  } = {}
) => {
  const user = await dbp.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!user) throw new AdminMfaNotFoundError('Admin account not found');

  const existing = await dbp.adminMfa.findUnique({ where: { userId } });
  const alreadyEnabled = Boolean(existing?.enabledAt && existing.enabledAt.getTime() > 0);

  if (alreadyEnabled && !allowOverwriteWithoutCode) {
    if (await isMfaLocked(userId)) {
      throw new AdminMfaLockedError();
    }
    const ok = verifyStoredTotp(existing, currentCode).valid;
    if (!ok) {
      await recordMfaFailure(userId);
      throw new AdminMfaCodeError('Current valid MFA code is required to re-enroll MFA');
    }
    await revokeMfaFailedCount(userId);
  }

  const secret = generateBase32Secret(20);
  const label = accountName || user.email || userId;
  const { plaintext: recoveryCodes, entries: recoveryEntries } = generateRecoveryCodePair(userId);
  const secretEnc = encodeStoredEnvelope({ secret, recoveryCodes: recoveryEntries });

  await dbp.adminMfa.upsert({
    where: { userId },
    create: {
      userId,
      secretEnc,
      enabledAt: new Date(0)
    },
    update: {
      secretEnc,
      enabledAt: new Date(0),
      lastVerifiedAt: null
    }
  });

  return {
    base32: secret,
    otpauthUrl: generateOtpAuthUri({ issuer, label, secret }),
    recoveryCodes
  };
};

const verifyStoredTotp = (row, code) => {
  if (!row?.secretEnc || typeof code !== 'string' || !code.trim()) {
    return { valid: false, step: null };
  }
  try {
    const env = decodeStoredEnvelope(row.secretEnc);
    return verifyTotp(env.secret, code);
  } catch (err) {
    logger.warn({ err: err.message }, 'Admin MFA secret could not be decrypted');
    return { valid: false, step: null };
  }
};

/**
 * Activates a provisioned secret (enabledAt === epoch) once the admin proves
 * possession of the authenticator app with a valid 6-digit TOTP code.
 */
export const enableAdminMfa = async (userId, code, { dbp = prisma } = {}) => {
  if (await isMfaLocked(userId)) {
    throw new AdminMfaLockedError();
  }
  const row = await dbp.adminMfa.findUnique({ where: { userId } });
  if (!row) throw new AdminMfaNotFoundError();
  if (row.enabledAt && row.enabledAt.getTime() > 0) {
    throw new AdminMfaStateError('Admin MFA is already enabled');
  }
  const check = verifyStoredTotp(row, code);
  if (!check.valid) {
    await recordMfaFailure(userId);
    throw new AdminMfaCodeError();
  }
  await revokeMfaFailedCount(userId);
  await consumeTotpStep(userId, check.step);
  const now = new Date();
  return dbp.adminMfa.update({
    where: { userId },
    data: { enabledAt: now, lastVerifiedAt: now }
  });
};

/**
 * Verifies a 6-digit TOTP code for an enabled admin account.
 * Enforces brute-force lockout and (for session elevation) rejects replaying
 * an already-consumed 30-second time step.
 */
export const verifyAdminMfaCode = async (
  userId,
  code,
  { dbp = prisma, allowReplayWithinStep = false } = {}
) => {
  if (await isMfaLocked(userId)) {
    return false;
  }
  const row = await dbp.adminMfa.findUnique({ where: { userId } });
  if (!row || !row.enabledAt || row.enabledAt.getTime() <= 0) {
    return false;
  }
  const check = verifyStoredTotp(row, code);
  if (!check.valid) {
    return false;
  }
  if (!allowReplayWithinStep) {
    const freshStep = await consumeTotpStep(userId, check.step);
    if (!freshStep) {
      return false;
    }
  }
  await revokeMfaFailedCount(userId);
  await dbp.adminMfa.update({
    where: { userId },
    data: { lastVerifiedAt: new Date() }
  });
  return true;
};

/**
 * Verifies and permanently consumes a single-use recovery code for an enabled
 * admin. Atomically re-encrypts `secretEnc` with the used code marked consumed
 * so the code can never be replayed.
 */
export const verifyAdminRecoveryCode = async (userId, recoveryCode, { dbp = prisma } = {}) => {
  if (await isMfaLocked(userId)) {
    throw new AdminMfaLockedError();
  }
  const normalized = normalizeRecoveryCode(recoveryCode);
  if (!normalized || normalized.length < 8) {
    await recordMfaFailure(userId);
    throw new AdminMfaCodeError('Invalid recovery code');
  }

  const run = async (tx) => {
    if (typeof tx.$queryRaw === 'function') {
      await tx.$queryRaw`SELECT id FROM "AdminMfa" WHERE "userId" = ${userId} FOR UPDATE`;
    }
    const row = await tx.adminMfa.findUnique({ where: { userId } });
    if (!row || !row.enabledAt || row.enabledAt.getTime() <= 0) {
      throw new AdminMfaNotFoundError('Admin MFA is not enabled');
    }

    const env = decodeStoredEnvelope(row.secretEnc);
    const candidateHashBuf = Buffer.from(hashRecoveryCode(userId, normalized), 'hex');
    let matchIndex = -1;

    for (let i = 0; i < env.recoveryCodes.length; i += 1) {
      const entry = env.recoveryCodes[i];
      if (!entry || entry.used || typeof entry.hash !== 'string') continue;
      const storedBuf = Buffer.from(entry.hash, 'hex');
      if (
        storedBuf.length === candidateHashBuf.length &&
        crypto.timingSafeEqual(storedBuf, candidateHashBuf)
      ) {
        matchIndex = i;
        break;
      }
    }

    if (matchIndex === -1) {
      return { matched: false, remaining: env.recoveryCodes.filter((c) => !c.used).length };
    }

    const updatedCodes = env.recoveryCodes.map((entry, idx) =>
      idx === matchIndex ? { ...entry, used: true, usedAt: new Date().toISOString() } : entry
    );
    const nextSecretEnc = encodeStoredEnvelope({
      secret: env.secret,
      recoveryCodes: updatedCodes
    });

    await tx.adminMfa.update({
      where: { userId },
      data: {
        secretEnc: nextSecretEnc,
        lastVerifiedAt: new Date()
      }
    });

    return {
      matched: true,
      remaining: updatedCodes.filter((c) => !c.used).length
    };
  };

  const result = typeof dbp.$transaction === 'function' ? await dbp.$transaction(run) : await run(dbp);
  if (!result.matched) {
    await recordMfaFailure(userId);
    throw new AdminMfaCodeError('Invalid or already-used recovery code');
  }

  await revokeMfaFailedCount(userId);
  return { verified: true, recoveryCodesRemaining: result.remaining };
};

/**
 * Generates a fresh set of single-use recovery codes, invalidating all
 * previously issued codes. Requires a valid current TOTP code.
 */
export const regenerateAdminRecoveryCodes = async (userId, totpCode, { dbp = prisma } = {}) => {
  if (await isMfaLocked(userId)) {
    throw new AdminMfaLockedError();
  }
  const row = await dbp.adminMfa.findUnique({ where: { userId } });
  if (!row || !row.enabledAt || row.enabledAt.getTime() <= 0) {
    throw new AdminMfaNotFoundError('Admin MFA is not enabled');
  }
  const check = verifyStoredTotp(row, totpCode);
  if (!check.valid) {
    await recordMfaFailure(userId);
    throw new AdminMfaCodeError();
  }
  await revokeMfaFailedCount(userId);

  const env = decodeStoredEnvelope(row.secretEnc);
  const { plaintext: recoveryCodes, entries } = generateRecoveryCodePair(userId);
  const nextSecretEnc = encodeStoredEnvelope({
    secret: env.secret,
    recoveryCodes: entries
  });

  await dbp.adminMfa.update({
    where: { userId },
    data: { secretEnc: nextSecretEnc, lastVerifiedAt: new Date() }
  });

  return { recoveryCodes, recoveryCodesRemaining: recoveryCodes.length };
};

export const disableAdminMfa = async (userId, code, { dbp = prisma } = {}) => {
  if (await isMfaLocked(userId)) {
    throw new AdminMfaLockedError();
  }
  const row = await dbp.adminMfa.findUnique({ where: { userId } });
  if (!row) throw new AdminMfaNotFoundError();
  const check = verifyStoredTotp(row, code);
  if (!check.valid) {
    await recordMfaFailure(userId);
    throw new AdminMfaCodeError();
  }
  await dbp.adminMfa.delete({ where: { userId } });
  await revokeMfaFailedCount(userId);
  localUsedTotpSteps.delete(userId);
  return true;
};

export const AdminMfaService = Object.freeze({
  isEnforced: isAdminMfaEnforced,
  getStatus: getAdminMfaStatus,
  getDetailedStatus: getAdminMfaDetailedStatus,
  provision: provisionAdminMfa,
  enable: enableAdminMfa,
  disable: disableAdminMfa,
  verify: verifyAdminMfaCode,
  verifyRecoveryCode: verifyAdminRecoveryCode,
  regenerateRecoveryCodes: regenerateAdminRecoveryCodes,
  isLocked: isMfaLocked,
  recordFailure: recordMfaFailure,
  clearFailures: revokeMfaFailedCount,
  clearLocalState: clearLocalMfaState
});
