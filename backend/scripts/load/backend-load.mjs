#!/usr/bin/env node
// Load test harness on top of autocannon. It points at a running dev server
// and reports throughput/latency for the cheap health path, the unauthenticated
// fast path, and the expensive auth login write (bcrypt + session).
//
// Usage:
//   DATABASE_URL=... REDIS_URL=... PORT=4399 NODE_ENV=test node src/server.js &
//   node scripts/load/backend-load.mjs [baseUrl]
import autocannon from 'autocannon';
import Redis from 'ioredis';
import crypto from 'crypto';

const BASE_URL = process.argv[2] || process.env.LOAD_URL || 'http://127.0.0.1:4399';
const CONNECTIONS = Number(process.env.LOAD_CONNECTIONS || 20);
const DURATION = Number(process.env.LOAD_DURATION || 8);
const LOGIN_CONNECTIONS = 4;
const GEO_TTL_SECONDS = 600;

if (!process.env.REDIS_URL) {
  console.error('REDIS_URL must be set so the harness can mint a geo-binding token for registration.');
  process.exit(2);
}
const redis = new Redis(process.env.REDIS_URL);

const email = `load.${Date.now()}@example.com`;
const password = 'Load-test-password-123!';

const request = async (path, options = {}) => {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'content-type': 'application/json', ...options.headers },
    ...options
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body };
};

const runTarget = ({ path, ...opts }) => new Promise((resolve) => {
  const instance = autocannon({ ...opts, url: `${BASE_URL}${path}`, connections: CONNECTIONS });
  instance.on('done', (result) => resolve(result));
});

const summarize = (name, result, expectedOk = new Set([200])) => {
  const rps = Math.round(result.requests.average);
  const lat = result.latency;
  const statuses = result.statusCodeStats ?? {};
  const errors = Object.entries(statuses)
    .filter(([code]) => !expectedOk.has(Number(code)))
    .reduce((acc, [, stats]) => acc + stats.count, 0);
  const line = `${name.padEnd(14)} ${rps.toString().padStart(5)} req/s  avg ${Math.round(lat.average)}ms p95 ${Math.round(lat.p99)}ms errors ${errors}`;
  console.log(line);
  return { name, rps, p99: lat.p99, errors };
};

const health = await request('/health');
if (health.status !== 200) {
  console.error(`Server not available at ${BASE_URL}/health (got ${health.status})`);
  process.exit(2);
}
console.log(`Server up at ${BASE_URL}; connections=${CONNECTIONS} duration=${DURATION}s`);

const geoToken = crypto.randomUUID();
await redis.set(`geo:binding:${geoToken}`, 'NG', 'EX', GEO_TTL_SECONDS);

const reg = await request('/auth/register', {
  method: 'POST',
  body: JSON.stringify({
    email,
    password,
    dateOfBirth: '1990-01-01',
    countryCode: 'NG',
    geoBinding: geoToken,
    deviceInfo: { platform: 'loadtest' }
  })
});
if (reg.status !== 201 && reg.status !== 409) {
  console.error(`register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  process.exit(2);
}
console.log(`Seeded login user ${email}`);

const summaries = [
  summarize('health', await runTarget({ path: '/health', duration: DURATION, method: 'GET' })),
  summarize('unauth-me', await runTarget({ path: '/auth/me', duration: DURATION, method: 'GET' }), new Set([401])),
  summarize(
    'login',
    await runTarget({
      path: '/auth/login',
      duration: DURATION,
      method: 'POST',
      connections: LOGIN_CONNECTIONS,
      body: JSON.stringify({ email, password }),
      headers: { 'content-type': 'application/json' }
    })
  )
];

const ok = summaries.every((s) => s.errors === 0) && summaries[0].p99 < 2000;
console.log(ok ? 'Load test: PASS' : 'Load test: FAIL (errors or health p99 > 2s)');
process.exit(ok ? 0 : 1);