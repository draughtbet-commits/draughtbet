import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import logger from '../../utils/logger.js';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();
const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export class AuthService {
  static async register(email, password, dateOfBirth, fingerprintHash) {
    // Note: Zod validation already confirmed 18+ in the controller before calling this
    try {
      const passwordHash = await bcrypt.hash(password, 12);
      
      const user = await prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: {
            email,
            passwordHash,
            isBanned: false, // Explicit requirement
            wallet: {
              create: {
                balanceMinorUnits: 0n,
                currency: 'NGN' // Phase 1 default
              }
            },
            devices: {
              create: {
                fingerprintHash
              }
            }
          },
          include: {
            wallet: true
          }
        });
        return newUser;
      });

      return user;
    } catch (err) {
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

  static async login(email, password, fingerprintHash) {
    const user = await prisma.user.findUnique({ where: { email } });
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

    // Upsert the device fingerprint log
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

    return this.issueTokens(user.id);
  }

  static async issueTokens(userId) {
    const accessToken = jwt.sign({ userId }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
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
      tier: user.tier,
      walletBalanceMinorUnits: user.wallet?.balanceMinorUnits.toString() || '0', // BigInt serialization
      unreadNotifications: user._count.notifications
    };
  }
}
