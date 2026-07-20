import pino from 'pino';

// Always output structured JSON.
// For pretty dev output, pipe externally: node server.js | pnpm pino-pretty
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
});

export default logger;

