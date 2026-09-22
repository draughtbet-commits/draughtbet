import express from 'express';
import { z } from 'zod';
import { AuthService } from './service.js';
import { isVerificationChallengeError } from './verificationChallengeService.js';
import { GeoService } from '../../services/geoService.js';
import { requireAuth } from '../../middleware/auth.js';
import { authRateLimiter, checkRateLimiter, verificationRateLimiter } from '../../middleware/rateLimit.js';
import { requireAppVersion } from '../../middleware/appVersion.js';
import { getIO } from '../../sockets/index.js';

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

const verifyStartSchema = z.object({
  channel: z.enum(['email', 'phone']),
  destination: z.string().trim().min(1).optional()
});

const verifyConfirmSchema = z.object({
  challengeId: z.string().trim().min(1),
  code: z.string().regex(/^\d{6}$/, 'Code must be exactly 6 digits')
});

const forgotPasswordSchema = z.object({
  identifier: z.string().trim().min(3)
});

const resetPasswordSchema = z.object({
  challengeId: z.string().trim().min(1),
  code: z.string().regex(/^\d{6}$/, 'Code must be exactly 6 digits'),
  newPassword: z.string()
    .min(8)
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
    .regex(/[0-9]/, 'Password must contain at least one digit')
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
  try {
    // Both userId and refreshToken should ideally come from the request
    const { userId, refreshToken } = req.body;
    if (!userId || !refreshToken) {
      return res.status(400).json({ error: 'userId and refreshToken required' });
    }
    const tokens = await AuthService.refresh(userId, refreshToken, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
      deviceInfo: req.body.deviceInfo
    });
    res.json(tokens);
  } catch (err) {
    if (err.message === 'Invalid or expired refresh token' || err.message === 'Account suspended') {
      return res.status(401).json({ error: err.message });
    }
    next(err);
  }
});

authRouter.post('/logout', requireAuth, async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ error: 'refreshToken required' });
    }
    // req.user.id is populated by requireAuth middleware
    await AuthService.logout(req.user.id, refreshToken);

    // End the user's live realtime connections so logout takes effect
    // immediately, not only when the access token naturally expires.
    // Access-token policy after logout: stateless access tokens remain valid
    // until natural expiry for HTTP; the socket session is revoked now.
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

// Contact verification (contract §3: /auth/verify/start + /auth/verify/confirm)
authRouter.post('/verify/start', requireAuth, verificationRateLimiter, async (req, res, next) => {
  try {
    const data = verifyStartSchema.parse(req.body);
    const result = await AuthService.startContactVerification(req.user.id, {
      channel: data.channel,
      destination: data.destination
    });
    res.json({ data: result });
  } catch (err) {
    if (isVerificationChallengeError(err)) {
      return res.status(err.status ?? 400).json({ error: { code: err.code, message: err.message, ...(err.resendAfterSeconds ? { resendAfterSeconds: err.resendAfterSeconds } : {}) } });
    }
    if (err && err.name === 'ZodError') {
      return res.status(400).json({ errors: err.errors || err.issues });
    }
    next(err);
  }
});

authRouter.post('/verify/confirm', requireAuth, verificationRateLimiter, async (req, res, next) => {
  try {
    const data = verifyConfirmSchema.parse(req.body);
    const result = await AuthService.confirmContactVerification(req.user.id, { challengeId: data.challengeId, code: data.code });
    res.json({ data: result });
  } catch (err) {
    if (isVerificationChallengeError(err)) {
      return res.status(err.status ?? 400).json({ error: { code: err.code, message: err.message } });
    }
    if (err && err.name === 'ZodError') {
      return res.status(400).json({ errors: err.errors || err.issues });
    }
    next(err);
  }
});

// Password recovery (contract §3: /auth/forgot-password + /auth/reset-password)
authRouter.post('/forgot-password', checkRateLimiter, async (req, res, next) => {
  try {
    const data = forgotPasswordSchema.parse(req.body);
    const result = await AuthService.forgotPassword({ identifier: data.identifier });
    res.json({ data: result });
  } catch (err) {
    if (err && err.name === 'ZodError') {
      return res.status(400).json({ errors: err.errors || err.issues });
    }
    next(err);
  }
});

authRouter.post('/reset-password', authRateLimiter, async (req, res, next) => {
  try {
    const data = resetPasswordSchema.parse(req.body);
    const result = await AuthService.resetPassword({
      challengeId: data.challengeId,
      code: data.code,
      newPassword: data.newPassword,
      ip: req.ip,
      userAgent: req.get('user-agent')
    });
    res.json({ data: result });
  } catch (err) {
    if (isVerificationChallengeError(err)) {
      return res.status(err.status ?? 400).json({ error: { code: err.code, message: err.message } });
    }
    if (err && err.name === 'ZodError') {
      return res.status(400).json({ errors: err.errors || err.issues });
    }
    next(err);
  }
});
