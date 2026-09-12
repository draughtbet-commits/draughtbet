import express from 'express';
import { z } from 'zod';
import { AuthService } from './service.js';
import { GeoService } from '../../services/geoService.js';
import { requireAuth } from '../../middleware/auth.js';
import { authRateLimiter, checkRateLimiter } from '../../middleware/rateLimit.js';
import logger from '../../utils/logger.js';

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
  countryCode: z.string().length(2).optional(),
  fingerprintHash: z.string().optional()
}).refine((d) => d.email || d.phone, { message: 'Email or phone is required' });

const loginSchema = z.object({
  email: z.string().email().optional(),
  phone: z.string().min(6).optional(),
  password: z.string(),
  fingerprintHash: z.string().optional(),
  fcmToken: z.string().optional()
}).refine((d) => d.email || d.phone, { message: 'Email or phone is required' });

const geolocateSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180)
});

const updateProfileSchema = z.object({
  // Only predesigned avatar ids are accepted. No uploads.
  avatar: z.string().trim().min(1).max(64)
});

const availabilitySchema = z.object({
  type: z.enum(['email', 'phone', 'username']),
  value: z.string().min(1)
});

authRouter.post('/register', authRateLimiter, async (req, res, next) => {
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
      countryCode: data.countryCode
    });
    // Auto-login: issue tokens in the same call so the app can skip the
    // separate sign-in step after account creation.
    const tokens = await AuthService.issueTokens(user.id);
    res.status(201).json({ message: 'User registered successfully', ...tokens });
  } catch (err) {
    if (err && err.name === 'ZodError') {
      return res.status(400).json({ errors: err.errors || err.issues });
    }
    if (err.message === 'Country not allowed') {
      return res.status(403).json({ error: 'This app is not available in your country' });
    }
    if (err.message === 'Account already exists') {
      return res.status(409).json({ error: 'An account with this email, phone or username already exists' });
    }
    // Let global error handler log unexpected errors securely
    next(err);
  }
});

authRouter.post('/login', authRateLimiter, async (req, res, next) => {
  try {
    const data = loginSchema.parse(req.body);
    const identifier = data.email || data.phone;
    const tokens = await AuthService.login(identifier, data.password, data.fingerprintHash, data.fcmToken);
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
    logger.info(result, 'geo-locate resolved');
    res.json(result);
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

authRouter.post('/refresh', authRateLimiter, async (req, res, next) => {
  try {
    // Both userId and refreshToken should ideally come from the request
    const { userId, refreshToken } = req.body;
    if (!userId || !refreshToken) {
      return res.status(400).json({ error: 'userId and refreshToken required' });
    }
    const tokens = await AuthService.refresh(userId, refreshToken);
    res.json(tokens);
  } catch (err) {
    if (err.message === 'Invalid or expired refresh token') {
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
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
});

authRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const profile = await AuthService.getProfile(req.user.id);
    res.json(profile);
  } catch (err) {
    next(err);
  }
});

authRouter.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const data = updateProfileSchema.parse(req.body);
    const profile = await AuthService.updateProfile(req.user.id, { avatar: data.avatar });
    res.json(profile);
  } catch (err) {
    if (err && err.name === 'ZodError') {
      return res.status(400).json({ errors: err.errors || err.issues });
    }
    if (err.message === 'User not found') {
      return res.status(404).json({ error: err.message });
    }
    next(err);
  }
});
