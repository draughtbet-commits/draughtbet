import express from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { AuthService } from './service.js';
import { GeoService } from '../../services/geoService.js';
import { requireAuth } from '../../middleware/auth.js';
import { authRateLimiter, checkRateLimiter } from '../../middleware/rateLimit.js';
import { requireAppVersion } from '../../middleware/appVersion.js';
import { getIO } from '../../sockets/index.js';
import { AdminMfaService } from '../mfa/service.js';
import {
  ACCESS_COOKIE_MAX_AGE_MS,
  setAuthCookies,
  setCsrfCookie,
  clearAuthCookies,
  extractRefreshFromCookie,
  isCookieAuthRequest
} from '../../utils/authCookies.js';

export const authRouter = express.Router();

// Note: the strict 5/min auth limiter is applied per-route to the credential
// endpoints below. The pre-auth helpers (geo-locate / check-availability) use
// the lighter checkRateLimiter because they are called on every keystroke.

// Zod schemas
const registerSchema = z.object({
  email: z.string().email().optional(),
  phone: z.string().min(6).optional(),
  username: z.string().trim().min(2).optional(),
  fullName: z.string().trim().optional(),
  address: z.string().trim().optional(),
  password: z.string()
    .min(8)
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
    .regex(/[0-9]/, 'Password must contain at least one digit'),
  dateOfBirth: z.string().refine((val) => {
    const dob = new Date(val);
    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const m = today.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) {
      age--;
    }
    return age >= 18;
  }, { message: 'Must be at least 18 years old' }),
  countryCode: z.string().length(2),
  geoBinding: z.string().min(8),
  fingerprintHash: z.string().optional(),
  deviceInfo: z.object({
    model: z.string().optional(),
    os: z.string().optional(),
    appVersion: z.string().optional()
  }).optional()
}).refine((d) => d.email || d.phone, { message: 'Email or phone is required' });

const loginSchema = z.object({
  email: z.string().email().optional(),
  phone: z.string().min(6).optional(),
  password: z.string(),
  fingerprintHash: z.string().optional(),
  fcmToken: z.string().optional(),
  deviceInfo: z.object({
    model: z.string().optional(),
    os: z.string().optional(),
    appVersion: z.string().optional()
  }).optional()
}).refine((d) => d.email || d.phone, { message: 'Email or phone is required' });

const geolocateSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180)
});

const availabilitySchema = z.object({
  type: z.enum(['email', 'phone', 'username']),
  value: z.string().min(1)
});

// Issues a fresh signed double-submit CSRF cookie for browser clients.
authRouter.get('/csrf', (_req, res) => {
  const csrfToken = setCsrfCookie(res);
  res.json({ csrfToken });
});

authRouter.post('/register', authRateLimiter, requireAppVersion, async (req, res, next) => {
  try {
    const data = registerSchema.parse(req.body);
    const user = await AuthService.register({
      email: data.email,
      phone: data.phone,
      username: data.username,
      fullName: data.fullName,
      address: data.address,
      password: data.password,
      dateOfBirth: data.dateOfBirth,
      fingerprintHash: data.fingerprintHash,
      countryCode: data.countryCode,
      geoBinding: data.geoBinding
    });
    // Auto-login: issue tokens in the same call so the app can skip the
    // separate sign-in step after account creation.
    const tokens = await AuthService.issueTokens(user.id, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
      deviceInfo: data.deviceInfo
    });
    res.status(201).json({ message: 'User registered successfully', ...tokens });
  } catch (err) {
    if (err && err.name === 'ZodError') {
      return res.status(400).json({ errors: err.errors || err.issues });
    }
    if (err.message === 'Country not allowed') {
      return res.status(403).json({ error: 'This app is not available in your country' });
    }
    if (err.message === 'Geo evidence required' || err.message === 'Geo evidence expired or invalid') {
      return res.status(400).json({ error: err.message });
    }
    if (err.message === 'Account already exists') {
      return res.status(409).json({ error: 'An account with this email, phone or username already exists' });
    }
    // Let global error handler log unexpected errors securely
    next(err);
  }
});

authRouter.post('/login', authRateLimiter, requireAppVersion, async (req, res, next) => {
  try {
    const data = loginSchema.parse(req.body);
    const identifier = data.email || data.phone;
    const tokens = await AuthService.login(identifier, data.password, data.fingerprintHash, data.fcmToken, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
      deviceInfo: data.deviceInfo
    });

    if (isCookieAuthRequest(req)) {
      const decoded = jwt.decode(tokens.accessToken) || {};
      const userId = decoded.userId;
      const csrfToken = setAuthCookies(res, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        userId
      });
      const mfaStatus = userId
        ? await AdminMfaService.getDetailedStatus(userId).catch(() => ({
            enforced: AdminMfaService.isEnforced(),
            provisioned: false,
            enabled: false,
            recoveryCodesRemaining: 0
          }))
        : { enforced: AdminMfaService.isEnforced(), provisioned: false, enabled: false, recoveryCodesRemaining: 0 };

      const expiresAt =
        typeof decoded.exp === 'number'
          ? new Date(decoded.exp * 1000).toISOString()
          : new Date(Date.now() + ACCESS_COOKIE_MAX_AGE_MS).toISOString();

      // Never return raw accessToken or refreshToken to cookie-based browser clients.
      return res.json({
        authenticated: true,
        userId,
        expiresIn: Math.floor(ACCESS_COOKIE_MAX_AGE_MS / 1000),
        expiresAt,
        csrfToken,
        mfa: {
          enforced: mfaStatus.enforced,
          provisioned: mfaStatus.provisioned,
          enabled: mfaStatus.enabled,
          verified: decoded.mfaVerified === true,
          recoveryCodesRemaining: mfaStatus.recoveryCodesRemaining ?? 0
        }
      });
    }

    res.json(tokens);
  } catch (err) {
    if (err && err.name === 'ZodError') {
      return res.status(400).json({ errors: err.errors || err.issues });
    }
    // Return a generic 401 for bad credentials / banned users
    if (err.message === 'Invalid credentials' || err.message === 'Account suspended') {
      return res.status(401).json({ error: err.message });
    }
    next(err);
  }
});

authRouter.post('/geo-locate', checkRateLimiter, async (req, res, next) => {
  try {
    const { lat, lng } = geolocateSchema.parse(req.body);
    const result = await GeoService.geolocate(lat, lng);
    // Bind the resolved country to an opaque token so registration later
    // proves its country came from this server-side resolution, not the
    // client. No binding is minted for a blocked country.
    const binding = result.allowed ? await AuthService.createGeoBinding(result.countryCode) : null;
    res.json({ ...result, binding });
  } catch (err) {
    if (err && err.name === 'ZodError') {
      return res.status(400).json({ errors: err.errors || err.issues });
    }
    next(err);
  }
});

authRouter.post('/check-availability', checkRateLimiter, async (req, res, next) => {
  try {
    const data = availabilitySchema.parse(req.body);
    const result = await AuthService.checkAvailability(data.type, data.value);
    res.json(result);
  } catch (err) {
    if (err && err.name === 'ZodError') {
      return res.status(400).json({ errors: err.errors || err.issues });
    }
    if (err.message === 'Invalid field type') {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

authRouter.post('/refresh', authRateLimiter, requireAppVersion, async (req, res, next) => {
  const cookieCreds = extractRefreshFromCookie(req);
  const useCookies = Boolean(cookieCreds) || isCookieAuthRequest(req);
  try {
    const userId = cookieCreds?.userId || req.body?.userId;
    const refreshToken = cookieCreds?.refreshToken || req.body?.refreshToken;
    if (!userId || !refreshToken) {
      if (useCookies) clearAuthCookies(res);
      return res.status(400).json({ error: 'userId and refreshToken required' });
    }
    const tokens = await AuthService.refresh(userId, refreshToken, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
      deviceInfo: req.body?.deviceInfo
    });

    if (useCookies) {
      const decoded = jwt.decode(tokens.accessToken) || {};
      const csrfToken = setAuthCookies(res, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        userId
      });
      const expiresAt =
        typeof decoded.exp === 'number'
          ? new Date(decoded.exp * 1000).toISOString()
          : new Date(Date.now() + ACCESS_COOKIE_MAX_AGE_MS).toISOString();

      return res.json({
        authenticated: true,
        userId,
        expiresIn: Math.floor(ACCESS_COOKIE_MAX_AGE_MS / 1000),
        expiresAt,
        csrfToken,
        mfaVerified: decoded.mfaVerified === true
      });
    }

    res.json(tokens);
  } catch (err) {
    if (err.message === 'Invalid or expired refresh token' || err.message === 'Account suspended') {
      if (useCookies) clearAuthCookies(res);
      return res.status(401).json({ error: err.message });
    }
    next(err);
  }
});

authRouter.post('/logout', requireAuth, async (req, res, next) => {
  try {
    const cookieCreds = extractRefreshFromCookie(req);
    const useCookies = req.authTransport === 'cookie' || Boolean(cookieCreds) || isCookieAuthRequest(req);
    const refreshToken = req.body?.refreshToken || cookieCreds?.refreshToken;

    if (!refreshToken && !useCookies) {
      return res.status(400).json({ error: 'refreshToken required' });
    }

    if (refreshToken) {
      await AuthService.logout(req.user.id, refreshToken);
    }

    if (useCookies) {
      clearAuthCookies(res);
    }

    // End the user's live realtime connections so logout takes effect
    // immediately, not only when the access token naturally expires.
    try {
      getIO().in(`user:${req.user.id}`).disconnectSockets(true);
    } catch (_) {
      // Socket layer not initialized (HTTP-only/test environment).
    }
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
});
