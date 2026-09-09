import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import _prisma from '../../utils/db.js';
import _redis from '../../utils/redis.js';
import { GeoService } from '../../services/geoService.js';

let prisma = _prisma;
let redis = _redis;
import logger from '../../utils/logger.js';
import dotenv from 'dotenv';

dotenv.config();

// Prisma initialized in utils/db.js

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET && process.env.NODE_ENV !== 'test') {
  throw new Error('FATAL: JWT_SECRET environment variable is missing.');
}
const jwtSecret = JWT_SECRET || 'test_secret';

const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

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

  static async register({ email, phone, username, fullName, address, password, dateOfBirth, fingerprintHash, countryCode }) {
    // Geolocation gate: reject signups from restricted countries before any
    // other work happens. countryCode is produced by POST /auth/geo-locate.
    if (countryCode && !GeoService.isCountryAllowed(countryCode)) {
      throw new Error('Country not allowed');
    }
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
          isBanned: false, // Explicit requirement
          ageVerified: true, // Zod in the controller already confirmed 18+
          countryCode: countryCode ? countryCode.toUpperCase() : null,
          wallet: {
            create: {
              balanceMinorUnits: 0n,
              currency: 'NGN' // Phase 1 default
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

  static async login(identifier, password, fingerprintHash, fcmToken = null) {
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

    return this.issueTokens(user.id);
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

  static async issueTokens(userId) {
    const accessToken = jwt.sign({ userId }, jwtSecret, { expiresIn: ACCESS_TOKEN_EXPIRY });
    const refreshTokenId = uuidv4();
    
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

  static async refresh(userId, oldRefreshTokenId) {
    const redisKey = `refresh:${userId}:${oldRefreshTokenId}`;
    
    if (redis) {
      const exists = await redis.get(redisKey);
      if (!exists) {
        throw new Error('Invalid or expired refresh token');
      }
      
      // Destroy the old token to rotate it (prevents reuse)
      await redis.del(redisKey);
    }
    
    // Issue new tokens
    return this.issueTokens(userId);
  }

  static async logout(userId, refreshTokenId) {
    const redisKey = `refresh:${userId}:${refreshTokenId}`;
    if (redis) {
      await redis.del(redisKey);
    }
    return true;
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

    return {
      id: user.id,
      email: user.email,
      username: user.username,
      fullName: user.fullName,
      avatar: user.avatar,
      tier: user.tier,
      walletBalanceMinorUnits: user.wallet?.balanceMinorUnits.toString() || '0', // BigInt serialization
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
