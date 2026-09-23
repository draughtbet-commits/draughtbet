import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { requireAppVersion, extractAppVersion } from '../appVersion.js';

describe('appVersion middleware', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.MIN_APP_VERSION;
    delete process.env.SUPPORTED_APP_VERSIONS;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const makeReq = (overrides = {}) => ({
    headers: {},
    body: {},
    query: {},
    get(name) {
      return this.headers[name.toLowerCase()] ?? this.headers[name];
    },
    ...overrides
  });

  it('passes through when the guard is disabled', () => {
    const next = jest.fn();
    requireAppVersion(makeReq(), {}, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('accepts a supported header version', () => {
    process.env.MIN_APP_VERSION = '2.1.0';
    const next = jest.fn();
    requireAppVersion(makeReq({ headers: { 'x-app-version': '2.1.0' } }), {}, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects an outdated version with 426', () => {
    process.env.MIN_APP_VERSION = '2.1.0';
    const req = makeReq({ headers: { 'x-app-version': '1.0.0' } });
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    requireAppVersion(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(426);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'UPGRADE_REQUIRED' }));
  });

  it('falls back to deviceInfo.appVersion in the body', () => {
    process.env.MIN_APP_VERSION = '2.1.0';
    const req = makeReq({ body: { deviceInfo: { appVersion: '2.1.0' } } });
    const next = jest.fn();
    requireAppVersion(req, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects the request when no version is supplied', () => {
    process.env.MIN_APP_VERSION = '2.1.0';
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    requireAppVersion(makeReq(), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(426);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'UPGRADE_REQUIRED' }));
  });

  it('extractAppVersion prefers the header, then body, then query', () => {
    expect(extractAppVersion(makeReq({ headers: { 'x-app-version': '1' }, body: { appVersion: '2' } }))).toBe('1');
    expect(extractAppVersion(makeReq({ body: { appVersion: '2' }, query: { appVersion: '3' } }))).toBe('2');
    expect(extractAppVersion(makeReq({ query: { appVersion: '3' } }))).toBe('3');
    expect(extractAppVersion(makeReq())).toBeNull();
  });
});