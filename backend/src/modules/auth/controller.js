import express from 'express';
import { z } from 'zod';
import { AuthService } from './service.js';
import { requireAuth } from '../../middleware/auth.js';
import { authRateLimiter } from '../../middleware/rateLimit.js';

export const authRouter = express.Router();

// Apply the strict 5/min rate limit to all auth endpoints
authRouter.use(authRateLimiter);

// Zod schemas
const registerSchema = z.object({
  email: z.string().email(),
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
  fingerprintHash: z.string().optional()
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
  fingerprintHash: z.string().optional()
});

authRouter.post('/register', async (req, res, next) => {
  try {
    const data = registerSchema.parse(req.body);
    await AuthService.register(data.email, data.password, data.dateOfBirth, data.fingerprintHash);
    res.status(201).json({ message: 'User registered successfully' });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ errors: err.errors });
    }
    // Let global error handler log unexpected errors securely
    next(err);
  }
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const data = loginSchema.parse(req.body);
    const tokens = await AuthService.login(data.email, data.password, data.fingerprintHash);
    res.json(tokens);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ errors: err.errors });
    }
    // Return a generic 401 for bad credentials / banned users
    if (err.message === 'Invalid credentials' || err.message === 'Account suspended') {
      return res.status(401).json({ error: err.message });
    }
    next(err);
  }
});

authRouter.post('/refresh', async (req, res, next) => {
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
    // req.user.userId is populated by requireAuth middleware
    await AuthService.logout(req.user.userId, refreshToken);
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
});

authRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const profile = await AuthService.getProfile(req.user.userId);
    res.json(profile);
  } catch (err) {
    next(err);
  }
});
