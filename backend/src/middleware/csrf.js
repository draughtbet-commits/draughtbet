import crypto from 'node:crypto';
import logger from '../utils/logger.js';
import {
  CSRF_COOKIE_NAME,
  ACCESS_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  parseCookies,
  verifyCsrfToken
} from '../utils/authCookies.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const getAllowedOrigins = () => {
  const raw = process.env.ADMIN_CORS_ORIGIN;
  if (raw) {
    return raw.split(',').map((o) => o.trim()).filter(Boolean);
  }
  return ['http://localhost:3000', 'http://localhost:3001'];
};

const isOriginAllowed = (originHeader) => {
  if (!originHeader) return true;
  const allowed = getAllowedOrigins();
  if (allowed.includes(originHeader)) return true;
  if (
    process.env.NODE_ENV === 'development' &&
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(originHeader)
  ) {
    return true;
  }
  if (process.env.NODE_ENV === 'test' && !process.env.ADMIN_CORS_ORIGIN) {
    return true;
  }
  return false;
};

/**
 * CSRF protection for cookie-authenticated state-changing requests.
 *
 * - Pure Bearer-header API clients (mobile Flutter app, CLI scripts) without
 *   auth cookies are exempt because browsers never attach Authorization headers
 *   automatically cross-site.
 * - Any state-changing request carrying `db_admin_access` or `db_admin_refresh`
 *   cookies MUST pass:
 *     1. Origin/Referer allowlist validation (when present), AND
 *     2. Signed double-submit CSRF token validation (`X-CSRF-Token` header
 *        timing-safely equals `db_csrf_token` cookie AND passes server HMAC).
 */
export const requireCsrfProtection = (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) {
    return next();
  }

  // Pure Authorization Bearer clients without auth cookies are not vulnerable to cookie CSRF.
  const hasBearer =
    typeof req.headers?.authorization === 'string' &&
    req.headers.authorization.startsWith('Bearer ');
  const cookies = parseCookies(req.headers?.cookie);
  const usingAuthCookies = Boolean(
    cookies[ACCESS_COOKIE_NAME] || cookies[REFRESH_COOKIE_NAME]
  );

  if (!usingAuthCookies) {
    return next();
  }
  if (hasBearer && !cookies[REFRESH_COOKIE_NAME]) {
    // Explicit Bearer auth header takes precedence over stale cookies unless calling refresh cookie flow
    return next();
  }

  // Allow fresh credential login even if a stale cookie exists, while still enforcing Origin check
  const isLoginEndpoint =
    req.path === '/auth/login' || req.originalUrl?.startsWith('/api/v1/auth/login');

  const origin = req.headers?.origin;
  if (origin && !isOriginAllowed(origin)) {
    logger.warn(
      { event: 'csrf_origin_rejected', origin, path: req.originalUrl || req.path, requestId: req.id },
      'CSRF protection rejected cross-origin request'
    );
    return res.status(403).json({ error: 'Cross-origin request blocked by CSRF policy', code: 'CSRF_ORIGIN_INVALID' });
  }

  if (isLoginEndpoint) {
    return next();
  }

  const cookieToken = cookies[CSRF_COOKIE_NAME];
  const headerToken = req.get?.('x-csrf-token') || req.headers?.['x-csrf-token'];

  if (typeof cookieToken !== 'string' || typeof headerToken !== 'string' || !cookieToken || !headerToken) {
    logger.warn(
      { event: 'csrf_token_missing', path: req.originalUrl || req.path, requestId: req.id },
      'CSRF token missing on cookie-authenticated mutation'
    );
    return res.status(403).json({ error: 'Invalid or missing CSRF token', code: 'CSRF_INVALID' });
  }

  const cookieBuf = Buffer.from(cookieToken, 'utf8');
  const headerBuf = Buffer.from(headerToken, 'utf8');
  const tokensMatch =
    cookieBuf.length === headerBuf.length && crypto.timingSafeEqual(cookieBuf, headerBuf);

  if (!tokensMatch || !verifyCsrfToken(cookieToken)) {
    logger.warn(
      { event: 'csrf_token_invalid', path: req.originalUrl || req.path, requestId: req.id },
      'CSRF token mismatch or invalid signature'
    );
    return res.status(403).json({ error: 'Invalid or missing CSRF token', code: 'CSRF_INVALID' });
  }

  return next();
};
