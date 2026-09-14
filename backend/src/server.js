import 'dotenv/config';
import app from './app.js';
import logger from './utils/logger.js';
import { initSocketServer } from './sockets/index.js';
import { waitForRateLimitRedis } from './middleware/rateLimit.js';

const PORT = process.env.PORT || 3000;

// Wait (bounded) for Redis so the shared rate limiter is in service before the
// first request. Degrades to per-process memory if Redis is not reachable.
await waitForRateLimitRedis();

const server = app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);
});

// Initialize Socket.IO
initSocketServer(server);

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});
