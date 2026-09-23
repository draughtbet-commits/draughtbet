import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  parseVersion,
  formatVersion,
  compareVersions,
  resolveAppVersionPolicy,
  isVersionSupported,
  formatPolicyForResponse
} from '../appVersion.js';

describe('appVersion', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.MIN_APP_VERSION;
    delete process.env.SUPPORTED_APP_VERSIONS;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('parseVersion', () => {
    it('parses full, partial and bare versions', () => {
      expect(parseVersion('2.1.0')).toEqual({ major: 2, minor: 1, patch: 0 });
      expect(parseVersion('2.1')).toEqual({ major: 2, minor: 1, patch: 0 });
      expect(parseVersion('2')).toEqual({ major: 2, minor: 0, patch: 0 });
    });

    it('ignores trailing build/suffix text', () => {
      expect(parseVersion('2.1.0+123')).toEqual({ major: 2, minor: 1, patch: 0 });
      expect(parseVersion('2.1.0-beta.1')).toEqual({ major: 2, minor: 1, patch: 0 });
    });

    it('rejects garbage', () => {
      for (const bad of ['', '  ', 'abc', '1.2.3.4', 'a.b.c', NaN, null, undefined]) {
        expect(parseVersion(bad)).toBeNull();
      }
    });
  });

  describe('compareVersions', () => {
    it('orders correctly across major/minor/patch', () => {
      expect(compareVersions({ major: 2, minor: 1, patch: 0 }, { major: 2, minor: 1, patch: 0 })).toBe(0);
      expect(compareVersions({ major: 2, minor: 1, patch: 1 }, { major: 2, minor: 1, patch: 0 })).toBe(1);
      expect(compareVersions({ major: 2, minor: 0, patch: 0 }, { major: 2, minor: 1, patch: 0 })).toBe(-1);
      expect(compareVersions({ major: 1, minor: 9, patch: 9 }, { major: 2, minor: 0, patch: 0 })).toBe(-1);
    });
  });

  describe('resolveAppVersionPolicy', () => {
    it('returns null when nothing is configured', () => {
      expect(resolveAppVersionPolicy()).toBeNull();
    });

    it('reads the min-version floor', () => {
      process.env.MIN_APP_VERSION = '2.1.0';
      expect(resolveAppVersionPolicy()).toEqual({ min: { major: 2, minor: 1, patch: 0 }, list: null });
    });

    it('reads the allowlist', () => {
      process.env.SUPPORTED_APP_VERSIONS = '2.1.0, 2.2.0';
      const policy = resolveAppVersionPolicy();
      expect(policy.list).toEqual([
        { major: 2, minor: 1, patch: 0 },
        { major: 2, minor: 2, patch: 0 }
      ]);
      expect(policy.min).toBeNull();
    });
  });

  describe('isVersionSupported', () => {
    it('allows everything when the guard is disabled', () => {
      expect(isVersionSupported('0.0.1')).toBe(true);
      expect(isVersionSupported(null)).toBe(true);
    });

    it('enforces a min-version floor', () => {
      process.env.MIN_APP_VERSION = '2.1.0';
      const policy = resolveAppVersionPolicy();
      expect(isVersionSupported('2.1.0', policy)).toBe(true);
      expect(isVersionSupported('3.0.0', policy)).toBe(true);
      expect(isVersionSupported('2.0.9', policy)).toBe(false);
    });

    it('enforces an exact allowlist', () => {
      process.env.SUPPORTED_APP_VERSIONS = '2.1.0,2.1.1';
      const policy = resolveAppVersionPolicy();
      expect(isVersionSupported('2.1.0', policy)).toBe(true);
      expect(isVersionSupported('2.1.1', policy)).toBe(true);
      expect(isVersionSupported('2.1.2', policy)).toBe(false);
    });

    it('requires both floor and allowlist when both are set', () => {
      process.env.MIN_APP_VERSION = '2.1.0';
      process.env.SUPPORTED_APP_VERSIONS = '2.1.0,3.1.0';
      const policy = resolveAppVersionPolicy();
      expect(isVersionSupported('2.1.0', policy)).toBe(true);
      expect(isVersionSupported('3.1.0', policy)).toBe(true);
      expect(isVersionSupported('2.5.0', policy)).toBe(false);
      expect(isVersionSupported('1.9.0', policy)).toBe(false);
    });

    it('rejects an unparseable client version', () => {
      process.env.MIN_APP_VERSION = '2.1.0';
      const policy = resolveAppVersionPolicy();
      expect(isVersionSupported('not-a-version', policy)).toBe(false);
      expect(isVersionSupported(null, policy)).toBe(false);
    });
  });

  describe('formatPolicyForResponse', () => {
    it('exposes the floor and list for the 426 payload', () => {
      process.env.MIN_APP_VERSION = '2.1.0';
      process.env.SUPPORTED_APP_VERSIONS = '2.1.0';
      expect(formatPolicyForResponse(resolveAppVersionPolicy())).toEqual({
        minimumVersion: '2.1.0',
        supportedVersions: ['2.1.0']
      });
      expect(formatPolicyForResponse(null)).toEqual({
        minimumVersion: null,
        supportedVersions: null
      });
    });
  });
});