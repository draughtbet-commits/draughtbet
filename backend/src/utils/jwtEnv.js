// JWT secret resolution with a guard against weak/sample values in
// production (S12). Shared by HTTP auth, socket auth and the auth service so
// all three enforce one policy.
const KNOWN_WEAK_JWT_SECRETS = new Set([
  'your-super-secret-jwt-key',
  'test_secret'
]);

export const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret && process.env.NODE_ENV !== 'test') {
    throw new Error('FATAL: JWT_SECRET environment variable is missing.');
  }
  if (
    secret &&
    process.env.NODE_ENV === 'production' &&
    KNOWN_WEAK_JWT_SECRETS.has(secret)
  ) {
    throw new Error(
      'FATAL: JWT_SECRET is a known sample value. Refusing to start in production.'
    );
  }
  return secret || 'test_secret';
};