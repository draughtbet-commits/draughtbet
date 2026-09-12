import pino from 'pino';

// Credential/secret field names that are never allowed in logs (S13).
// Stored lowercase; keys are matched after lowercasing so camelCase,
// snake_case and mixed caps all scrub at any depth.
export const SENSITIVE_KEYS = new Set([
  'authorization',
  'cookie',
  'cookies',
  'set-cookie',
  'token',
  'tokens',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'password',
  'passwd',
  'secret',
  'secrets',
  'apikey',
  'api_key',
  'x-api-key',
  'fcmtoken',
  'fingerprinthash'
]);

export const CENSOR = '[REDACTED]';

// Scrub every secret-valued key in an object/array tree in place, so no
// synthetic/generated value can survive serialization regardless of depth.
export const redactValue = (value) => {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }
  for (const key of Object.keys(value)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      value[key] = CENSOR;
    } else {
      redactValue(value[key]);
    }
  }
  return value;
};

// Defense in depth alongside the logMethod hook. Fast-redact has no "any
// depth" wildcard, so cover top-level and the common one-level nesting that
// error/provider serializers produce.
export const REDACT_PATHS = [
  '*.authorization',
  '*.token',
  '*.tokens',
  '*.password',
  '*.secret',
  '*.secrets',
  '*.apiKey',
  '*.api_key',
  '*.apikey',
  '*.fcmToken',
  '*.cookie',
  '*.set-cookie',
  '*.accessToken',
  '*.refreshToken',
  'authorization',
  'token',
  'tokens',
  'password',
  'passwd',
  'secret',
  'secrets',
  'apiKey',
  'api_key',
  'apikey',
  'fcmToken',
  'cookie',
  'set-cookie',
  'accessToken',
  'refreshToken',
  'fingerprintHash'
];

export const LOGGER_OPTIONS = {
  level: process.env.LOG_LEVEL || 'info',
  redact: { paths: REDACT_PATHS, censor: CENSOR },
  hooks: {
    logMethod(inputArgs, method) {
      if (inputArgs[0] && typeof inputArgs[0] === 'object') {
        redactValue(inputArgs[0]);
      }
      return method.apply(this, inputArgs);
    }
  }
};

export const makeLogger = (destination) => pino(LOGGER_OPTIONS, destination);

// Always output structured JSON.
// For pretty dev output, pipe externally: node server.js | pnpm pino-pretty
const logger = makeLogger();

// HTTP access log. Emits only safe request/response shape (method, path,
// status, latency, request/user ids). Request headers and query strings are
// never read into the record, so bearer credentials, cookies and
// query-string secrets cannot reach the log stream.
export const createHttpLogger = (baseLogger = logger) => (req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    baseLogger.info(
      {
        requestId: req.id,
        userId: req.user?.id,
        route: `${req.method} ${req.path}`,
        statusCode: res.statusCode,
        responseTimeMs: Date.now() - startedAt
      },
      'HTTP request complete'
    );
  });
  next();
};

export const httpLogger = createHttpLogger();

export default logger;