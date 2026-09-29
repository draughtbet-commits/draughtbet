// Clears leftover PENDING_REVIEW withdrawals through the real admin endpoint so
// a recording starts from a wallet with nothing unexplained in flight. Rejecting
// is the correct lever: it releases the reservation through the ledger rather
// than deleting rows, so the double-entry stays balanced.
//
//   node --env-file=.env scripts/clear-pending-withdrawals.mjs
import prisma from '../src/utils/db.js';
import redis from '../src/utils/redis.js';

const API = process.env.DRIVE_API || 'http://127.0.0.1:3100/api/v1';
const PLAYER_EMAIL = 'withdraw.dev@draughtsarena.net';
const STAFF_EMAIL = 'finance.dev@draughtsarena.net';

const call = async (method, path, { token, body, idempotencyKey } = {}) => {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

const redisReady = () =>
  new Promise((resolve) => {
    if (!redis) return resolve();
    if (redis.isReady) return resolve();
    redis.once('ready', resolve);
    setTimeout(resolve, 3000);
  });

const token = async (email) => {
  const key = `drive:token:${email}`;
  const cached = redis ? await redis.get(key) : null;
  if (cached) return cached;
  const res = await call('POST', '/auth/login', { body: { email, password: 'Draughts@Dev2026' } });
  const value = res.body?.data?.accessToken ?? res.body?.accessToken;
  if (redis) await redis.set(key, value, 'EX', 20 * 60);
  return value;
};

const main = async () => {
  await redisReady();
  const user = await prisma.user.findUnique({ where: { email: PLAYER_EMAIL } });
  const staffToken = await token(STAFF_EMAIL);

  const stale = await prisma.withdrawal.findMany({
    where: { userId: user.id, status: 'PENDING_REVIEW' },
    select: { id: true, reference: true },
  });
  if (stale.length === 0) {
    console.log('nothing pending to clear');
  }
  for (const w of stale) {
    const res = await call('POST', `/admin/withdrawals/${w.id}/reject`, {
      token: staffToken,
      body: { reason: 'Cleared before a screen recording' },
      idempotencyKey: `clear-${w.id}`,
    });
    console.log(`rejected ${w.reference} -> ${res.status} ${res.body?.withdrawal?.status ?? res.body?.error}`);
  }

  const balance = await call('GET', '/wallet/balance', {
    token: await token(PLAYER_EMAIL),
  });
  console.log('balance now ->', JSON.stringify(balance.body?.balance));

  await prisma.$disconnect();
  if (redis) redis.disconnect();
};

main().catch(async (error) => {
  console.error('clear failed:', error.message);
  await prisma.$disconnect();
  if (redis) redis.disconnect();
  process.exit(1);
});
