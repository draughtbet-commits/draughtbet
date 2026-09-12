import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import {
  CENSOR,
  SENSITIVE_KEYS,
  makeLogger,
  redactValue,
  createHttpLogger
} from '../logger.js';

describe('logger redaction (S13)', () => {
  const SYNTHETIC_BEARER = 'Bearer synthetic.secret.token.0123456789';
  const SYNTHETIC_COOKIE = 'sid=synthetic-cookie-value-9876';
  const QUERY_SECRET = 'synthetic-query-token';

  const captureLogger = () => {
    const lines = [];
    const list = makeLogger({ write: (s) => lines.push(s) });
    return { list, lines };
  };

  const runRequest = (logger, req) => {
    const res = new EventEmitter();
    res.statusCode = 200;
    logger(req, res, () => {});
    res.emit('finish');
  };

  it('keeps a synthetic bearer, cookie and query secret out of the HTTP access log', () => {
    const { list, lines } = captureLogger();
    const http = createHttpLogger(list);

    runRequest(http, {
      id: 'req-1',
      method: 'POST',
      path: '/auth/login',
      headers: {
        authorization: SYNTHETIC_BEARER,
        cookie: SYNTHETIC_COOKIE,
        host: 'localhost'
      },
      user: { id: 'user-123' }
    });

    const line = JSON.parse(lines[0]);
    expect(line.route).toBe('POST /auth/login');
    expect(line.requestId).toBe('req-1');
    expect(line.userId).toBe('user-123');
    const serialized = JSON.stringify(line);
    expect(serialized).not.toContain('synthetic.secret.token');
    expect(serialized).not.toContain('synthetic-cookie-value');
    expect(serialized).not.toContain(QUERY_SECRET);
    expect(serialized).not.toContain('authorization');
    expect(serialized).not.toContain('cookie');
  });

  it('redacts secrets nested inside error objects', () => {
    const { list, lines } = captureLogger();
    const err = Object.assign(new Error('boom'), {
      token: 'nested-error-token',
      config: { headers: { Authorization: 'Bearer nested-error-authorization' } }
    });

    list.error({ err }, 'nested error');

    const serialized = JSON.stringify(JSON.parse(lines[0]));
    expect(serialized).not.toContain('nested-error-token');
    expect(serialized).not.toContain('nested-error-authorization');
    expect(serialized).toContain(CENSOR);
  });

  it('redacts credentials and tokens at arbitrary depth of custom props', () => {
    const { list, lines } = captureLogger();

    list.info(
      {
        data: {
          user: { refreshToken: 'nested-refresh-token', fcmToken: 'nested-fcm-token' },
          apiKey: 'nested-api-key'
        },
        password: 'top-level-password',
        moved: { target: { secret: 'deep-platform-secret' } }
      },
      'custom props'
    );

    const line = JSON.parse(lines[0]);
    expect(line.data.user.refreshToken).toBe(CENSOR);
    expect(line.data.user.fcmToken).toBe(CENSOR);
    expect(line.data.apiKey).toBe(CENSOR);
    expect(line.password).toBe(CENSOR);
    expect(line.moved.target.secret).toBe(CENSOR);
  });

  it('redactValue scrubs case-insensitively through nested arrays', () => {
    const fixture = {
      Authorization: 'A',
      headers: [{ authorization: 'B', cookie: 'C', RefreshToken: 'D' }],
      ok: 'kept'
    };

    redactValue(fixture);

    expect(fixture.Authorization).toBe(CENSOR);
    expect(fixture.headers[0].authorization).toBe(CENSOR);
    expect(fixture.headers[0].cookie).toBe(CENSOR);
    expect(fixture.headers[0].RefreshToken).toBe(CENSOR);
    expect(fixture.ok).toBe('kept');
  });

  it('stores sensitive key names in lowercase for case-insensitive matching', () => {
    for (const key of ['authorization', 'password', 'refreshtoken', 'fcmtoken', 'apikey', 'fingerprinthash']) {
      expect(SENSITIVE_KEYS.has(key)).toBe(true);
    }
    expect(SENSITIVE_KEYS.has('refreshToken')).toBe(false);
  });
});