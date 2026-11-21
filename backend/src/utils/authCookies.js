import crypto from 'node:crypto';
import { getCsrfSecret } from './secrets.js';

export const ACCESS_COOKIE_NAME = 'db_admin_access';
export const REFRESH_COOKIE_NAME = 'db_admin_refresh';
export const CSRF_COOKIE_NAME = 'db_csrf_token';

export const ACCESS_COOKIE_MAX_AGE_MS = 15 * 60 * 1000; // 15 minutes
export const REFRESH_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Strict RFC 6265 Cookie header parser. Returns a plain key->value map.
 */
export const parseCookies = (cookieHeader) => {
  const cookies = Object.create(null);
  if (typeof cookieHeader !== 'string' || !cookieHeader.trim()) {
    return cookies;
  }
  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const name = pair.slice(0, idx).trim();
    if (!name || name === '__proto__' || name === 'constructor' || name === 'prototype') {
      continue;
    }
    let val = pair.slice(idx + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val.slice(1, -1);
    }
    try {
      cookies[name] = decodeURIComponent(val);
    } catch {
      cookies[name] = val;
    }
  }
  return cookies;
};

/**
 * Resolves cookie security flags from runtime environment:
 * - HttpOnly enforced for all JWT/refresh cookies
 * - Secure enforced in production, under APP_ENFORCE_TLS=true, or when SameSite=None
 * - SameSite defaults to 'strict' (configurable via COOKIE_SAMESITE: strict | lax | none)
 * - Optional Domain via COOKIE_DOMAIN
 */
export const resolveCookiePolicy = () => {
  const rawSameSite = (process.env.COOKIE_SAMESITE || 'strict').trim().toLowerCase();
  const sameSite = ['strict', 'lax', 'none'].includes(rawSameSite) ? rawSameSite : 'strict';
  const secure =
    process.env.NODE_ENV === 'production' ||
    process.env.APP_ENFORCE_TLS === 'true' ||
    sameSite === 'none';
  const domain = typeof process.env.COOKIE_DOMAIN === 'string' && process.env.COOKIE_DOMAIN.trim()
    ? process.env.COOKIE_DOMAIN.trim()
    : undefined;

  return { sameSite, secure, domain };
};

/**
 * Mints an HMAC-signed CSRF token (`<nonce>.<hmac>`) bound to the server's
 * CSRF secret so neither cross-site attackers nor subdomain cookie-injection
 * can forge a valid token.
 */
export const generateCsrfToken = () => {
  const nonce = crypto.randomBytes(24).toString('base64url');
  const sig = crypto
    .createHmac('sha256', getCsrfSecret())
    .update(`csrf:v1:${nonce}`)
    .digest('base64url');
  return `${nonce}.${sig}`;
};

/**
 * Timing-safe verification of a signed CSRF token.
 */
export const verifyCsrfToken = (token) => {
  if (typeof token !== 'string' || !token) return false;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const [nonce, sig] = parts;
  const expected = crypto
    .createHmac('sha256', getCsrfSecret())
    .update(`csrf:v1:${nonce}`)
    .digest('base64url');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const receivedBuf = Buffer.from(sig, 'utf8');
  if (expectedBuf.length !== receivedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
};

export const setCsrfCookie = (res, token = generateCsrfToken()) => {
  const { sameSite, secure, domain } = resolveCookiePolicy();
  res.cookie(CSRF_COOKIE_NAME, token, {
    httpOnly: false, // Intentionally readable by same-origin admin-web JS for double-submit header
    secure,
    sameSite,
    path: '/',
    maxAge: REFRESH_COOKIE_MAX_AGE_MS,
    ...(domain ? { domain } : {})
  });
  return token;
};

/**
 * Sets HttpOnly access & refresh cookies plus a signed double-submit CSRF cookie.
 * Refresh cookie is strictly scoped to `/api/v1/auth` so it is never sent on
 * ordinary API traffic.
 */
export const setAuthCookies = (res, { accessToken, refreshToken, userId, csrfToken = null }) => {
  const { sameSite, secure, domain } = resolveCookiePolicy();

  if (accessToken) {
    res.cookie(ACCESS_COOKIE_NAME, accessToken, {
      httpOnly: true,
      secure,
      sameSite,
      path: '/api/v1',
      maxAge: ACCESS_COOKIE_MAX_AGE_MS,
      ...(domain ? { domain } : {})
    });
  }

  if (refreshToken && userId) {
    res.cookie(REFRESH_COOKIE_NAME, `${userId}.${refreshToken}`, {
      httpOnly: true,
      secure,
      sameSite,
      path: '/api/v1/auth',
      maxAge: REFRESH_COOKIE_MAX_AGE_MS,
      ...(domain ? { domain } : {})
    });
  }

  const activeCsrf = csrfToken && verifyCsrfToken(csrfToken) ? csrfToken : generateCsrfToken();
  setCsrfCookie(res, activeCsrf);
  return activeCsrf;
};

export const clearAuthCookies = (res) => {
  const { sameSite, secure, domain } = resolveCookiePolicy();
  const base = {
    secure,
    sameSite,
    ...(domain ? { domain } : {})
  };
  res.clearCookie(ACCESS_COOKIE_NAME, { ...base, httpOnly: true, path: '/api/v1' });
  res.clearCookie(REFRESH_COOKIE_NAME, { ...base, httpOnly: true, path: '/api/v1/auth' });
  res.clearCookie(CSRF_COOKIE_NAME, { ...base, httpOnly: false, path: '/' });
};

/**
 * Parses `userId` and `refreshToken` from the HttpOnly refresh cookie.
 */
export const extractRefreshFromCookie = (req) => {
  const cookies = parseCookies(req.headers?.cookie);
  const raw = cookies[REFRESH_COOKIE_NAME];
  if (typeof raw !== 'string' || !raw.includes('.')) return null;
  const dotIdx = raw.indexOf('.');
  const userId = raw.slice(0, dotIdx).trim();
  const refreshToken = raw.slice(dotIdx + 1).trim();
  if (!userId || !refreshToken) return null;
  return { userId, refreshToken };
};

export const extractAccessFromCookie = (req) => {
  const cookies = parseCookies(req.headers?.cookie);
  const raw = cookies[ACCESS_COOKIE_NAME];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
};

export const hasAuthCookies = (req) => {
  const cookies = parseCookies(req.headers?.cookie);
  return Boolean(cookies[ACCESS_COOKIE_NAME] || cookies[REFRESH_COOKIE_NAME]);
};

export const isCookieAuthRequest = (req) => {
  const mode = req.get?.('x-auth-mode') || req.headers?.['x-auth-mode'];
  if (typeof mode === 'string' && mode.trim().toLowerCase() === 'cookie') {
    return true;
  }
  return hasAuthCookies(req);
};
