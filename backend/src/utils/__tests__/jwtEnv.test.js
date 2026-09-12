import { jest } from '@jest/globals';
import { getJwtSecret } from '../jwtEnv.js';

describe('getJwtSecret (S12)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.JWT_SECRET;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('throws when JWT_SECRET is missing outside tests', () => {
    process.env.NODE_ENV = 'production';
    expect(() => getJwtSecret()).toThrow(/JWT_SECRET environment variable is missing/);
  });

  it('falls back to the test secret under NODE_ENV=test', () => {
    process.env.NODE_ENV = 'test';
    expect(getJwtSecret()).toBe('test_secret');
  });

  it('accepts a strong secret in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'a'.repeat(64);
    expect(getJwtSecret()).toBe('a'.repeat(64));
  });

  it('refuses known sample secrets in production', () => {
    process.env.NODE_ENV = 'production';
    for (const sample of ['your-super-secret-jwt-key', 'test_secret']) {
      process.env.JWT_SECRET = sample;
      expect(() => getJwtSecret()).toThrow(/known sample value/);
    }
  });

  it('still allows the sample secret outside production', () => {
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET = 'your-super-secret-jwt-key';
    expect(getJwtSecret()).toBe('your-super-secret-jwt-key');
  });
});