import crypto from 'crypto';
import bcrypt from 'bcrypt';
import prisma from '../../utils/db.js';
import redis from '../../utils/redis.js';
import logger from '../../utils/logger.js';

// Verification engine. The VerificationChallenge row is purpose-scoped
// (ChallengeType: EMAIL_VERIFY / PHONE_VERIFY / PASSWORD_RESET) so a code
// minted for one job can never be satisfied for another. Codes are 6-digit,
// time-boxed (5 min), capped at 5 attempts and stored ONLY as a bcrypt hash.
// The OTP value is never persisted and never logged (decisions "API error
// contract" + "Logging and audit").

export const OTP_TTL_SECONDS = 300; // contract: expiresInSeconds 300
export const RESEND_AFTER_SECONDS = 60; // contract: resendAfterSeconds 60
export const OTP_MAX_ATTEMPTS = 5;
export const BCRYPT_ROUNDS = 10;

export const VERIFY_PURPOSES = new Set(['EMAIL_VERIFY', 'PHONE_VERIFY']);
export const CONTACT_VERIFY_PURPOSES = ['EMAIL_VERIFY', 'PHONE_VERIFY'];
export const RESET_PURPOSE = 'PASSWORD_RESET';

// Delivery is the provider registry's job (deliveryProvider.js); this default
// is the discard fallback used by tests/CI. Never log the code.
export const defaultDeliver = async ({ userId, purpose }) => {
  logger.info({ userId, purpose }, 'OTP issued (no delivery provider configured)');
  return true;
};

// Dev/test-only mailbox: stashes the code in Redis under
// `dev:otp-mail:<challengeId>` so an e2e driver can read it back to confirm.
// The code still never reaches the logs. Activation is explicit via
// DEV_OTP_MAILBOX=1 (or skipped when Redis is not connected) so production
// keeps the discard-by-default behavior.
export const mailboxDeliverKey = (challengeId) => `dev:otp-mail:${challengeId}`;

export const mailboxDeliver = async ({ challengeId, code, userId }) => {
  if (redis && challengeId && code) {
    await redis.set(mailboxDeliverKey(challengeId), code, 'EX', OTP_TTL_SECONDS);
    logger.info({ userId, challengeId }, 'OTP stashed in dev mailbox (never logged)');
    return true;
  }
  return defaultDeliver({ userId, purpose: null });
};

export const mailboxReadCode = async (challengeId) => {
  if (!redis) return null;
  const value = await redis.get(mailboxDeliverKey(challengeId));
  return value ?? null;
};

export const generateOtpCode = () => crypto.randomInt(100000, 1000000).toString();

export class VerificationChallengeError extends Error {
  constructor(message, { status = 400, code = null, extra = null } = {}) {
    super(message);
    this.name = 'VerificationChallengeError';
    this.status = status;
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

/**
 * True when the error carries the verification error envelope. Also matches
 * subclasses (e.g. OTPDeliveryError from deliveryProvider.js) so controller
 * handlers surface their status instead of the generic 500.
 */
export const isVerificationChallengeError = (err) =>
  Boolean(err && (err.name === 'VerificationChallengeError' || err.name === 'OTPDeliveryError'));

const fail = (message, status, code, extra = null) =>
  new VerificationChallengeError(message, { status, code, extra });

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export const createVerificationChallenge = async (
  userId,
  purpose,
  { dbp = prisma, now = new Date(), deliver = defaultDeliver, generate = generateOtpCode, destination = null } = {}
) => {
  if (!VERIFY_PURPOSES.has(purpose) && purpose !== RESET_PURPOSE) {
    throw fail('Unsupported challenge purpose', 400, 'INVALID_PURPOSE');
  }

  const since = new Date(now.getTime() - RESEND_AFTER_SECONDS * 1000);
  const latest = await dbp.verificationChallenge.findFirst({
    where: { userId, type: purpose, verifiedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true }
  });
  if (latest && latest.createdAt > since) {
    const wait = RESEND_AFTER_SECONDS - Math.floor((now - latest.createdAt) / 1000);
    throw fail('OTP resend is rate limited', 429, 'RATE_LIMITED', { resendAfterSeconds: Math.max(1, wait) });
  }

  const code = generate();
  const codeHash = await bcrypt.hash(code, BCRYPT_ROUNDS);
  const challenge = await dbp.verificationChallenge.create({
    data: {
      userId,
      type: purpose,
      codeHash,
      expiresAt: new Date(now.getTime() + OTP_TTL_SECONDS * 1000),
      attempts: 0,
      maxAttempts: OTP_MAX_ATTEMPTS
    }
  });

  try {
    await deliver({ userId, purpose, code, challengeId: challenge.id, destination });
  } catch (err) {
    // Delivery failed: roll the challenge back so a retry is not blocked by the
    // resend-cooldown and no orphan challenge lingers. Safe because the code is
    // only a bcrypt hash at this point and has not been delivered anywhere.
    await dbp.verificationChallenge.delete({ where: { id: challenge.id } }).catch(() => {});
    throw err;
  }
  return {
    challengeId: challenge.id,
    expiresInSeconds: OTP_TTL_SECONDS,
    resendAfterSeconds: RESEND_AFTER_SECONDS
  };
}

// ---------------------------------------------------------------------------
// Verify (purpose-guarded, attempts-capped, expiry-honouring)
// ---------------------------------------------------------------------------

export const verifyVerificationChallenge = async (
  challengeId,
  code,
  { purposes = null, dbp = prisma, now = new Date() } = {}
) => {
  const challenge = await dbp.verificationChallenge.findUnique({
    where: { id: challengeId },
    include: { user: { select: { id: true, emailVerified: true, phoneVerified: true, email: true, phone: true } } }
  });
  if (!challenge) throw fail('Challenge not found', 404, 'OTP_INVALID');

  // Purpose guard EARLY (before any code comparison): a reset code can never
  // satisfy a contact verify and vice versa.
  if (purposes && !purposes.includes(challenge.type)) {
    throw fail('Challenge purpose mismatch', 403, 'FORBIDDEN');
  }

  if (challenge.verifiedAt) throw fail('Challenge already consumed', 409, 'OTP_INVALID');

  if (new Date(challenge.expiresAt) <= now) {
    throw fail('Challenge expired', 410, 'OTP_EXPIRED');
  }

  if (challenge.attempts >= challenge.maxAttempts) {
    throw fail('Too many attempts', 429, 'OTP_ATTEMPTS_EXCEEDED');
  }

  const match = await bcrypt.compare(code, challenge.codeHash);
  if (!match) {
    await dbp.verificationChallenge.update({
      where: { id: challengeId },
      data: { attempts: challenge.attempts + 1 }
    });
    throw fail('Invalid code', 400, 'OTP_INVALID');
  }

  const verified = await dbp.verificationChallenge.update({
    where: { id: challengeId },
    data: { verifiedAt: now }
  });

  return { challenge: verified, user: challenge.user };
};