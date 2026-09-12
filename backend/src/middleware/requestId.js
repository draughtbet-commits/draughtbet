import { randomUUID } from 'node:crypto';
import logger from '../utils/logger.js';

const MAX_REQUEST_ID_LENGTH = 128;

// Sets a request ID used for correlating logs, responses and errors across a
// single HTTP request (privacy/audit: see decisions.md "Logging and audit").
// Honours a client-supplied x-request-id only when it is short and non-empty.
export const requestIdMiddleware = (req, res, next) => {
  const incoming = req.headers['x-request-id'];
  if (typeof incoming === 'string' && incoming.trim().length > 0 && incoming.length <= MAX_REQUEST_ID_LENGTH) {
    req.id = incoming.trim();
  } else {
    req.id = randomUUID();
  }
  res.setHeader('x-request-id', req.id);
  next();
};

// Final error handler. Never leaks stack traces, DB internals or paths to the
// client (decisions.md "API error contract").
export const finalErrorHandler = (err, req, res, _next) => {
  const requestId = req.id;
  logger.error(
    { err, requestId, userId: req.user?.id, route: `${req.method} ${req.path}` },
    'Unhandled exception'
  );
  res.status(500).json({
    code: 'INTERNAL_ERROR',
    message: 'Internal Server Error',
    requestId
  });
};