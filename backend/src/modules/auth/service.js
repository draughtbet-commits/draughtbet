import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import _prisma from '../../utils/db.js';
import _redis from '../../utils/redis.js';
import { GeoService } from '../../services/geoService.js';
import { getLedgerAvailable, ensureUserAccounts } from '../../services/ledgerService.js';
import {
  createVerificationChallenge,
  verifyVerificationChallenge,
  CONTACT_VERIFY_PURPOSES,
  RESET_PURPOSE,
  VerificationChallengeError
} from './verificationChallengeService.js';
import { getDeliveryProvider } from './deliveryProvider.js';

let prisma = _prisma;
let redis = _redis;
import logger from '../../utils/logger.js';
import { getJwtSecret } from '../../utils/jwtEnv.js';
import dotenv from 'dotenv';

dotenv.config();

// Prisma initialized in utils/db.js

const jwtSecret = getJwtSecret();

const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const GEO_BINDING_TTL_SECONDS = 10 * 60; // geo evidence lasts 10 minutes

// UserSession stores only the SHA-256 of the opaque refresh token, never the
// token itself, so a DB leak cannot replay a captured row.
const hashRefreshToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function computeAge(dateOfBirth) {
  const dob = new Date(dateOfBirth);
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
  return age;
}

// Atomic refresh-token rotation: curl GET and DEL in one step so exactly one
// concurrent caller wins per token.
const ROTATE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;

function normalizePhone(phone) {
  if (!phone) return phone;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6) return phone; // not a plausible phone, keep as-is
  return `+${digits}`;
}

export class AuthService {
  static __setPrisma(mockPrisma) {
    prisma = mockPrisma;
  }

  static __setRedis(mockRedis) {
    redis = mockRedis;
  }

  static async register({ email, phone, username, fullName, address, password, dateOfBirth, fingerprintHash, countryCode, geoBinding }) {
    // Geo evidence gate: a registration must carry the country the server
    // resolved (POST /auth/geo-locate) plus the opaque binding that proves it.
    if (!countryCode) {
      throw new Error('Geo evidence required');
    }
    const boundCountry = await this.consumeGeoBinding(geoBinding);
    if (!boundCountry) {
      throw new Error('Geo evidence expired or invalid');
    }
    if (boundCountry.toUpperCase() !== countryCode.toUpperCase()) {
      throw new Error('Country not allowed');
    }
    if (!GeoService.isCountryAllowed(countryCode)) {
      throw new Error('Country not allowed');
    }
    const dob = new Date(dateOfBirth);
    const ageVerified = computeAge(dob) >= 18;

    try {
      const passwordHash = await bcrypt.hash(password, 12);

const user = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          email,
          phone: normalizePhone(phone),
          username,
          fullName,
          address,
          passwordHash,
          dateOfBirth: dob,
          isBanned: false, // Explicit requirement
          ageVerified,
          countryCode: countryCode.toUpperCase(),
          eligibility: {
            create: {
              countryCode: countryCode.toUpperCase(),
              countryAllowed: true,
              dateOfBirth: dob,
              ageVerified
            }
          },
          wallet: {
            create: {
              currency: 'NGN' // default currency
            }
          },
          devices: fingerprintHash
            ? {
                create: {
                  fingerprintHash
                }
              }
            : undefined
        },
        include: {
          wallet: true
        }
      });
      // V2 read flip: a new wallet starts with zero value in the ledger (the
      // PLAYER_AVAILABLE / PLAYER_LOCKED / PLAYER_WITHDRAWAL_PENDING accounts),
      // not as an opening-balance mirror. No ADJUSTMENT posting needed for 0.
      await ensureUserAccounts(tx, newUser.id, 'NGN');
      return newUser;
    });

      return user;
    } catch (err) {
      if (err && err.code === 'P2002') {
        // A unique constraint (email/phone/username) was violated.
        throw new Error('Account already exists');
      }
      // CRITICAL: Log securely without exposing passwords or raw bodies
      logger.error({
        err: err.message,
        email,
        fingerprintHash,
        event: 'register_failed'
      }, 'Atomic registration transaction failed');
      throw new Error('Registration failed');
    }
  }

  static async login(identifier, password, fingerprintHash, fcmToken = null, { ip = null, userAgent = null, deviceInfo = null } = {}) {
    const where = identifier.includes('@')
      ? { email: identifier }
      : { phone: normalizePhone(identifier) };
    const user = await prisma.user.findUnique({ where });
    if (!user) {
      throw new Error('Invalid credentials');
    }

    if (user.isBanned) {
      throw new Error('Account suspended');
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw new Error('Invalid credentials');
    }

    if (fingerprintHash) {
      const existingDevice = await prisma.deviceFingerprint.findFirst({
        where: { userId: user.id, fingerprintHash }
      });
      if (existingDevice) {
        await prisma.deviceFingerprint.update({
          where: { id: existingDevice.id },
          data: { lastSeen: new Date() }
        });
      } else {
        await prisma.deviceFingerprint.create({
          data: { userId: user.id, fingerprintHash }
        });
      }
    }
    if (fcmToken) {
      await prisma.user.update({
        where: { id: user.id },
        data: { fcmToken }
      });
    }

    return this.issueTokens(user.id, { ip, userAgent, deviceInfo });
  }

  static async checkAvailability(type, value) {
    let where;
    if (type === 'email') {
      where = { email: value.trim().toLowerCase() };
    } else if (type === 'phone') {
      where = { phone: normalizePhone(value) };
    } else if (type === 'username') {
      where = { username: value.trim() };
    } else {
      throw new Error('Invalid field type');
    }
    const existing = await prisma.user.findUnique({
      where,
      select: { id: true }
    });
    return { available: existing === null };
  }

  /**
   * Issues the opaque token that binds a geo-locate result to a later
   * registration. The server stores the resolved country under the token so
   * registration can prove the country came from the server, not the client.
   * Returns null when no token could be minted (Redis unavailable).
   */
  static async createGeoBinding(countryCode) {
    if (!redis) return null;
    const binding = uuidv4();
    await redis.set(`geo:binding:${binding}`, countryCode, 'EX', GEO_BINDING_TTL_SECONDS);
    return binding;
  }

  /**
   * Returns the country bound to a geo token and consumes it (one-time use).
   * Null when the token is unknown, already used, or Redis is unavailable.
   */
  static async consumeGeoBinding(binding) {
    if (!binding || !redis) return null;
    const key = `geo:binding:${binding}`;
    const code = await redis.get(key);
    if (code) {
      await redis.del(key);
    }
    return code;
  }

  static async issueTokens(userId, { family = null, ip = null, userAgent = null, deviceInfo = null } = {}) {
    const refreshTokenId = uuidv4();

    // Durable session row (reuse-detection spine): only the token hash is
    // stored. Each rotation moves the family forward and revokes the old row.
    const session = prisma
      ? await prisma.userSession.create({
          data: {
            userId,
            refreshTokenHash: hashRefreshToken(refreshTokenId),
            family: family ?? uuidv4(),
            lastRotatedAt: new Date(),
            deviceInfo: deviceInfo ?? undefined,
            ipAddress: ip ?? undefined,
            userAgent: userAgent ?? undefined,
            status: 'ACTIVE',
            expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000)
          }
        })
      : null;

    const accessToken = jwt.sign({ userId, sessionId: session?.id }, jwtSecret, { expiresIn: ACCESS_TOKEN_EXPIRY });

    // Key: refresh:{userId}:{tokenId} -> value doesn't matter much, TTL is the focus
    const redisKey = `refresh:${userId}:${refreshTokenId}`;

    if (redis) {
      await redis.set(redisKey, 'valid', 'EX', REFRESH_TOKEN_TTL_SECONDS);
    }

    return {
      accessToken,
      refreshToken: refreshTokenId
    };
  }

  static async recordSecurityEvent(userId, type, metadata = {}, ip = null, userAgent = null) {
    if (!prisma) return null;
    return prisma.securityEvent.create({
      data: { userId, type, metadata, ipAddress: ip, userAgent }
    }).catch((err) => {
      logger.warn({ err, userId, type }, 'Failed to write security event');
      return null;
    });
  }

  /**
   * Rotates a refresh token. Reuse detection is database-backed: a presented
   * token whose UserSession row is no longer ACTIVE was already rotated (or
   * revoked/expired), which means a leaked token is being replayed — every
   * outstanding session for the account is then revoked and the event is
   * recorded. Redis remains the atomicity gate for the rotation itself.
   */
  static async refresh(userId, oldRefreshTokenId, { ip = null, userAgent = null, deviceInfo = null } = {}) {
    const hash = hashRefreshToken(oldRefreshTokenId);
    const session = prisma
      ? await prisma.userSession.findUnique({ where: { refreshTokenHash: hash } })
      : null;

    // Reuse: the token maps to a row that was already superseded/revoked.
    if (session && session.status !== 'ACTIVE') {
      const revoked = await this.revokeAllRefreshTokens(userId);
      await this.recordSecurityEvent(
        userId,
        'REFRESH_REUSE_DETECTED',
        { family: session.family, sessionId: session.id, revokedSessions: revoked },
        ip,
        userAgent
      );
      logger.warn({ userId, family: session.family }, 'Refresh token reuse detected; all sessions revoked');
      throw new Error('Invalid or expired refresh token');
    }

    const redisKey = `refresh:${userId}:${oldRefreshTokenId}`;
    if (redis) {
      const consumed = await redis.eval(ROTATE_SCRIPT, 1, redisKey);
      if (!consumed) {
        // Simply expired (Redis TTL) while the row is still ACTIVE.
        if (session && session.status === 'ACTIVE' && prisma) {
          await prisma.userSession
            .update({ where: { refreshTokenHash: hash }, data: { status: 'EXPIRED' } })
            .catch(() => {});
        }
        throw new Error('Invalid or expired refresh token');
      }
    }

    // A banned or deleted account must never mint a fresh access token from a
    // refresh token, even though the refresh endpoint is not authenticated.
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, isBanned: true }
    });
    if (!user) {
      throw new Error('Invalid or expired refresh token');
    }
    if (user.isBanned) {
      throw new Error('Account suspended');
    }

    // Legit rotation: supersede the old row; the next token keeps the family.
    if (session && prisma) {
      await prisma.userSession.update({
        where: { refreshTokenHash: hash },
        data: { status: 'REVOKED' }
      });
    }

    // Issue new tokens
    return this.issueTokens(userId, {
      family: session?.family ?? null,
      ip,
      userAgent,
      deviceInfo
    });
  }

  /**
   * Revokes every refresh token and session a user holds. Called on ban (and
   * internally on refresh-token reuse) so a suspended/compromised account
   * cannot rotate any outstanding token.
   */
  static async revokeAllRefreshTokens(userId) {
    let redisCount = 0;
    if (redis) {
      const pattern = `refresh:${userId}:*`;
      const keys = [];
      const stream = redis.scanStream({ match: pattern, count: 100 });
      for await (const batch of stream) keys.push(...batch);
      if (keys.length > 0) {
        await redis.del(keys);
      }
      redisCount = keys.length;
    }
    if (prisma) {
      await prisma.userSession.updateMany({
        where: { userId, status: { in: ['ACTIVE', 'EXPIRED'] } },
        data: { status: 'REVOKED' }
      });
    }
    return redisCount;
  }

  /**
   * Bans or un-bans a user and, when banning, revokes their sessions. The
   * controller is responsible for disconnecting live sockets.
   */
  static async setAccountStatus(userId, banned) {
    const user = await prisma.user.update({
      where: { id: userId },
      data: { isBanned: banned },
      select: { id: true, email: true, isBanned: true }
    });
    if (banned) {
      await this.revokeAllRefreshTokens(userId);
    }
    return user;
  }

  static async logout(userId, refreshTokenId) {
    const redisKey = `refresh:${userId}:${refreshTokenId}`;
    if (redis) {
      await redis.del(redisKey);
    }
    if (prisma) {
      await prisma.userSession.updateMany({
        where: { userId, refreshTokenHash: hashRefreshToken(refreshTokenId) },
        data: { status: 'REVOKED' }
      });
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Contact verification, password reset, sessions
  // -------------------------------------------------------------------------

  // Delivery selection: an explicit caller-provided deliver fn wins (tests).
  // Otherwise the registered provider (OTP_DELIVERY) serves the code; the
  // registry handles dev mailbox / discard / production email or fail-closed.
  static selectDeliver(providers = {}) {
    const { deliver, mailboxDeliver: boxDeliver } = providers;
    if (deliver) return deliver;
    const provider = getDeliveryProvider();
    return (args) => provider.deliver(args);
  }

  static async startContactVerification(userId, { channel, destination, dbp = prisma, deliver, generate } = {}) {
    if (channel !== 'email' && channel !== 'phone') {
      throw new VerificationChallengeError('Unsupported verification channel', { status: 400, code: 'INVALID_CHANNEL' });
    }
    const purpose = channel === 'email' ? 'EMAIL_VERIFY' : 'PHONE_VERIFY';
    const account = await dbp.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, phone: true }
    });
    if (!account) {
      throw new VerificationChallengeError('User not found', { status: 404, code: 'USER_NOT_FOUND' });
    }
    const expected = channel === 'email' ? account.email : account.phone;
    if (destination && expected && destination.trim().toLowerCase() !== expected.trim().toLowerCase()) {
      throw new VerificationChallengeError('Destination does not match the account contact', {
        status: 400,
        code: 'DESTINATION_MISMATCH'
      });
    }
    if (!expected) {
      throw new VerificationChallengeError(`No ${channel} on file to verify`, {
        status: 400,
        code: 'NO_CONTACT_ON_FILE'
      });
    }
    return createVerificationChallenge(userId, purpose, {
      dbp,
      generate,
      destination: expected,
      deliver: this.selectDeliver({ deliver })
    });
  }

  /**
   * Confirms a contact-verify challenge and marks the bound contact verified.
   * Exposes the "OTP_INVALID/OTP_EXPIRED/OTP_ATTEMPTS_EXCEEDED" contract
   * surface; only EMAIL_VERIFY/PHONE_VERIFY challenges can be confirmed here —
   * a PASSWORD_RESET code can never verify a contact.
   */
  static async confirmContactVerification(userId, { challengeId, code, dbp = prisma, now } = {}) {
    const { user, challenge } = await verifyVerificationChallenge(challengeId, code, {
      dbp,
      now,
      purposes: CONTACT_VERIFY_PURPOSES
    });
    if (user.id !== userId) {
      throw new VerificationChallengeError('Challenge does not belong to this user', { status: 403, code: 'FORBIDDEN' });
    }
    const isEmail = challenge.type === 'EMAIL_VERIFY';
    await dbp.user.update({
      where: { id: userId },
      data: isEmail ? { emailVerified: true } : { phoneVerified: true }
    });
    return {
      verified: true,
      channel: isEmail ? 'email' : 'phone'
    };
  }

  /**
   * Starts a password reset. Always answers `{accepted: true}` (no account
   * enumeration); if an account exists for the identifier a PASSWORD_RESET
   * challenge is issued. Consumers must use a dedicated limiter to stop code
   * spraying.
   */
  static async forgotPassword({ identifier, dbp = prisma, deliver, generate } = {}) {
    const where = identifier.includes('@')
      ? { email: identifier.trim().toLowerCase() }
      : { phone: normalizePhone(identifier) };
    const account = await dbp.user.findUnique({ where, select: { id: true, isBanned: true } });
    if (account && !account.isBanned) {
      try {
        await createVerificationChallenge(account.id, RESET_PURPOSE, {
          dbp,
          generate,
          destination: identifier,
          deliver: this.selectDeliver({ deliver })
        });
      } catch (err) {
        // Anti-enumeration: the public answer is ALWAYS `{accepted:true}` even
        // when delivery is unavailable/failed (a 503 here would reveal which
        // identifiers are real accounts). The failure surfaces loudly in logs
        // instead. Verification-path callers still get the fail-closed 503.
        logger.error({ userId: account.id, identifier, error: err.message, name: err.name }, 'Password-reset OTP delivery failed; code not sent');
      }
    }
    return { accepted: true };
  }

  /**
   * Completes a password reset from a PASSWORD_RESET challenge. Rejects verify
   * challenges outright (purpose guard). On success every session for the
   * account is revoked so all refresh tokens are dead.
   */
  static async resetPassword({ challengeId, code, newPassword, dbp = prisma, ip = null, userAgent = null, now } = {}) {
    const { user } = await verifyVerificationChallenge(challengeId, code, {
      dbp,
      now,
      purposes: [RESET_PURPOSE]
    });
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await dbp.user.update({
      where: { id: user.id },
      data: { passwordHash }
    });
    const revoked = await this.revokeAllRefreshTokens(user.id);
    await this.recordSecurityEvent(user.id, 'PASSWORD_CHANGED', { via: 'reset' }, ip, userAgent);
    return { reset: true, sessionsRevoked: true };
  }

  static async listSessions(userId, { currentSessionId = null, dbp = prisma } = {}) {
    const rows = await dbp.userSession.findMany({
      where: { userId, status: 'ACTIVE' },
      orderBy: { lastRotatedAt: 'desc' }
    });
    return rows.map((row) => ({
      sessionId: row.id,
      deviceName: row.deviceInfo?.model ?? row.deviceInfo?.os ?? 'Unknown device',
      lastUsedAt: row.lastRotatedAt.toISOString(),
      current: currentSessionId != null && row.id === currentSessionId
    }));
  }

  static async revokeSession(userId, sessionId, { dbp = prisma, ip = null, userAgent = null } = {}) {
    const session = await dbp.userSession.findUnique({ where: { id: sessionId } });
    if (!session) {
      throw new VerificationChallengeError('Session not found', { status: 404, code: 'SESSION_NOT_FOUND' });
    }
    if (session.userId !== userId) {
      throw new VerificationChallengeError('Forbidden', { status: 403, code: 'FORBIDDEN' });
    }
    if (session.status !== 'ACTIVE') {
      return { revoked: true, alreadyRevoked: true };
    }
    await dbp.userSession.update({ where: { id: sessionId }, data: { status: 'REVOKED' } });
    await this.recordSecurityEvent(userId, 'SESSION_REVOKED', { sessionId }, ip, userAgent);
    return { revoked: true, alreadyRevoked: false };
  }

  static async getProfile(userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        wallet: true,
        _count: {
          select: { notifications: { where: { isRead: false } } }
        }
      }
    });

    if (!user) throw new Error('User not found');

    // V2 read flip: the profile's balance is the ledger PLAYER_AVAILABLE net,
    // not the legacy Wallet balance column.
    const available = await getLedgerAvailable(
      prisma,
      userId,
      user.wallet?.currency ?? 'NGN'
    );

    return {
      id: user.id,
      email: user.email,
      username: user.username,
      fullName: user.fullName,
      avatar: user.avatar,
      tier: user.tier,
      walletBalanceMinorUnits: available.toString(),
      unreadNotifications: user._count.notifications
    };
  }

  static async updateProfile(userId, { avatar }) {
    const user = await prisma.user.update({
      where: { id: userId },
      data: { ...(avatar !== undefined ? { avatar } : {}) }
    });
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      fullName: user.fullName,
      avatar: user.avatar,
      tier: user.tier
    };
  }
}
