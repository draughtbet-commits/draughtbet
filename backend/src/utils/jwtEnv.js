// JWT secret resolution with strict fail-closed guards against missing,
// short, or known sample/weak values in production. Shared by HTTP auth,
// socket auth, auth service, and derived signing utilities.
export const KNOWN_WEAK_JWT_SECRETS = new Set([
  'your-super-secret-jwt-key',
  'test_secret',
  'secret',
  'changeme',
  'jwt_secret',
  'development_secret',
  'dev_secret'
]);

const MIN_PRODUCTION_JWT_SECRET_LENGTH = 32;

export const getJwtSecret = () => {
  const secret = typeof process.env.JWT_SECRET === 'string' ? process.env.JWT_SECRET.trim() : '';
  if (!secret && process.env.NODE_ENV !== 'test') {
    throw new Error('FATAL: JWT_SECRET environment variable is missing.');
  }
  if (secret && process.env.NODE_ENV === 'production') {
    if (KNOWN_WEAK_JWT_SECRETS.has(secret)) {
      throw new Error(
        'FATAL: JWT_SECRET is a known sample value. Refusing to start in production.'
      );
    }
    if (secret.length < MIN_PRODUCTION_JWT_SECRET_LENGTH) {
      throw new Error(
        `FATAL: JWT_SECRET must be at least ${MIN_PRODUCTION_JWT_SECRET_LENGTH} characters in production.`
      );
    }
  }
  // Only NODE_ENV=test may use the deterministic test key when JWT_SECRET is unset.
  if (!secret) {
    return 'test_secret';
  }
  return secret;
};
