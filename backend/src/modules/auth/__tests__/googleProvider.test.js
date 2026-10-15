import { jest } from '@jest/globals';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.REDIS_URL = '';

const { verifyGoogleIdToken, resetGoogleJwksCache } = await import('../googleProvider.js');

const AUDIENCE = 'test-client.apps.googleusercontent.com';
const ISSUER = 'https://accounts.google.com';
const KID = 'test-kid-1';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' };

const jwksHttp = (keys = [jwk], { ok = true } = {}) => ({
  ok,
  headers: { get: () => 'public, max-age=3600' },
  json: async () => ({ keys })
});

const sign = (overrides = {}, { key = privateKey, expiresIn = '1h' } = {}) =>
  jwt.sign(
    { sub: 'google-sub-1', email: 'User@Example.com', email_verified: true, name: 'User Example', iss: ISSUER, aud: AUDIENCE, ...overrides },
    key,
    { algorithm: 'RS256', keyid: KID, expiresIn }
  );

const verify = (token, opts = {}) =>
  verifyGoogleIdToken(token, { audience: AUDIENCE, fetchImpl: jest.fn(async () => jwksHttp()), ...opts });

beforeEach(() => {
  resetGoogleJwksCache();
  delete process.env.GOOGLE_CLIENT_ID;
});

describe('verifyGoogleIdToken', () => {
  it('returns a normalised profile for a valid token', async () => {
    const profile = await verify(sign());
    expect(profile).toMatchObject({
      sub: 'google-sub-1',
      email: 'user@example.com', // lower-cased
      emailVerified: true,
      name: 'User Example'
    });
  });

  it('rejects a token signed by a different key', async () => {
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    await expect(verify(sign({}, { key: other.privateKey }))).rejects.toMatchObject({ name: 'GoogleAuthError' });
  });

  it('rejects an expired token', async () => {
    await expect(verify(sign({}, { expiresIn: '-10s' }))).rejects.toMatchObject({ name: 'GoogleAuthError' });
  });

  it('rejects a token for the wrong audience', async () => {
    await expect(verify(sign({ aud: 'someone-else.apps.googleusercontent.com' }))).rejects.toMatchObject({ name: 'GoogleAuthError' });
  });

  it('rejects a token from the wrong issuer', async () => {
    await expect(verify(sign({ iss: 'https://evil.example' }))).rejects.toMatchObject({ name: 'GoogleAuthError' });
  });

  it('rejects an unverified Google email', async () => {
    await expect(verify(sign({ email_verified: false }))).rejects.toMatchObject({ code: 'GOOGLE_EMAIL_UNVERIFIED', status: 403 });
  });

  it('rejects a malformed token', async () => {
    await expect(verify('not-a-jwt')).rejects.toMatchObject({ code: 'GOOGLE_AUTH_FAILED' });
  });

  it('rejects an unknown signing key id', async () => {
    await expect(verify(sign(), { fetchImpl: jest.fn(async () => jwksHttp([])) })).rejects.toMatchObject({ name: 'GoogleAuthError' });
  });

  it('fails closed (503) when no audience is configured', async () => {
    await expect(
      verifyGoogleIdToken(sign(), { audience: undefined, fetchImpl: jest.fn() })
    ).rejects.toMatchObject({ code: 'GOOGLE_AUTH_UNAVAILABLE', status: 503 });
  });

  it('fails closed (503) when the JWKS endpoint is unreachable', async () => {
    await expect(verify(sign(), { fetchImpl: jest.fn(async () => { throw new Error('network'); }) }))
      .rejects.toMatchObject({ code: 'GOOGLE_AUTH_UNAVAILABLE', status: 503 });
  });

  it('serves a second verification from the cached JWKS', async () => {
    const fetchImpl = jest.fn(async () => jwksHttp());
    await verify(sign(), { fetchImpl });
    await verify(sign(), { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
