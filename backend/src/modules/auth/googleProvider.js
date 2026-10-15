import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import logger from '../../utils/logger.js';

// Verifies a Google ID token (the JWT the Android client gets from Google
// Sign-In) without pulling in google-auth-library: google's signing keys are
// plain JWKS, Node can turn a JWK straight into a KeyObject, and jsonwebtoken
// is already a dependency. The token is only trusted after its signature AND
// its issuer/audience/expiry are checked -- a decoded-but-unverified payload
// would let anyone forge an identity.

export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export class GoogleAuthError extends Error {
  constructor(message = 'Google sign-in failed', { status = 401, code = 'GOOGLE_AUTH_FAILED' } = {}) {
    super(message);
    this.name = 'GoogleAuthError';
    this.status = status;
    this.code = code;
  }
}

let cache = { keys: null, expiresAt: 0 };

export const resetGoogleJwksCache = () => {
  cache = { keys: null, expiresAt: 0 };
};

const fetchJwks = async ({ fetchImpl, jwksUrl, now = Date.now() }) => {
  if (cache.keys && cache.expiresAt > now) return cache.keys;
  let response;
  try {
    response = await fetchImpl(jwksUrl);
  } catch (err) {
    logger.warn({ error: err.message }, 'Unable to reach Google signing keys');
    throw new GoogleAuthError('Google sign-in is unavailable', { status: 503, code: 'GOOGLE_AUTH_UNAVAILABLE' });
  }
  if (!response.ok) {
    throw new GoogleAuthError('Google sign-in is unavailable', { status: 503, code: 'GOOGLE_AUTH_UNAVAILABLE' });
  }
  const body = await response.json();
  const keys = Array.isArray(body.keys) ? body.keys : [];
  // Honor Google's Cache-Control so a rotated key is picked up without every
  // request hitting Google.
  const cacheControl = response.headers?.get?.('cache-control') ?? '';
  const maxAge = /max-age=(\d+)/.exec(cacheControl);
  const ttlMs = maxAge ? Number(maxAge[1]) * 1000 : 60 * 60 * 1000;
  cache = { keys, expiresAt: now + ttlMs };
  return keys;
};

/**
 * Verifies an ID token and returns the trusted profile.
 *
 * @param {string} idToken  The `idToken` from GoogleSignInAuthentication.
 * @param {object} [opts]
 * @param {string} [opts.audience]  The Web OAuth client id (GOOGLE_CLIENT_ID).
 * @param {Function} [opts.fetchImpl]
 * @param {string} [opts.jwksUrl]
 * @returns {Promise<{sub:string,email:string,emailVerified:boolean,name:string|null,picture:string|null}>}
 * @throws {GoogleAuthError}
 */
export const verifyGoogleIdToken = async (idToken, {
  audience = process.env.GOOGLE_CLIENT_ID,
  fetchImpl = fetch,
  jwksUrl = GOOGLE_JWKS_URL
} = {}) => {
  if (!audience) {
    // Fail closed: without a configured audience any token would "verify" and
    // the feature would be an open door.
    throw new GoogleAuthError('Google sign-in is not configured', { status: 503, code: 'GOOGLE_AUTH_UNAVAILABLE' });
  }
  if (!idToken || typeof idToken !== 'string') {
    throw new GoogleAuthError('A Google ID token is required', { status: 400, code: 'GOOGLE_TOKEN_REQUIRED' });
  }

  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || typeof decoded === 'string' || !decoded.header?.kid) {
    throw new GoogleAuthError('Malformed Google token');
  }

  const keys = await fetchJwks({ fetchImpl, jwksUrl });
  const jwk = keys.find((key) => key.kid === decoded.header.kid);
  if (!jwk) {
    // A rotated key: drop the cache so the next call refetches rather than
    // rejecting valid tokens until the TTL lapses.
    resetGoogleJwksCache();
    throw new GoogleAuthError('Unknown Google signing key');
  }

  let payload;
  try {
    const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    payload = jwt.verify(idToken, publicKey, {
      algorithms: ['RS256'],
      audience,
      issuer: GOOGLE_ISSUERS
    });
  } catch (err) {
    throw new GoogleAuthError('Invalid Google token');
  }

  if (!payload.sub || !payload.email) {
    throw new GoogleAuthError('Google account is missing an email');
  }
  if (payload.email_verified !== true && payload.email_verified !== 'true') {
    throw new GoogleAuthError('Google email is not verified', { status: 403, code: 'GOOGLE_EMAIL_UNVERIFIED' });
  }

  return {
    sub: payload.sub,
    email: payload.email.toLowerCase(),
    emailVerified: true,
    name: payload.name ?? null,
    picture: payload.picture ?? null
  };
};
