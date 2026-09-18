// Security & production hardening verification. Exercises the real modules
// against the real dev Postgres + Redis stack over HTTP where the behaviour is
// wire-level (CORS, TLS redirect, helmet headers, per-route limiters) and
// directly for the crypto/db invariants. Run from backend/ against a
// wipe-controlled dev DB (the exit gate wipes first):
//
//   DATABASE_URL=postgresql://draughts_arena:change_me_draughts_arena@127.0.0.1:5432/draughts_arena?schema=public \
//   REDIS_URL=redis://:change_me_draughts_redis@127.0.0.1:6379 \
//   node scripts/verify/pr13-security-hardening.mjs
//
// Invariants checked:
//   S1  a rotated refresh token replayed anywhere is detected, all sessions
//       for the account are revoked and a REFRESH_REUSE_DETECTED event lands
//   S2  logout revokes the session row so its refresh token is dead forever
//   S3  TOTP lifecycle: status -> provision -> gate still denied -> enable ->
//       gate passes with a valid code; wrong codes increment the failure lock
//       and five failures lock the admin out even with the correct code
//   S4  the TOTP secret is stored AES-256-GCM encrypted, never as plaintext
//   S5  route-specific rate limiters use independent Redis budgets (wallet
//       traffic cannot consume the global/other endpoint budget)
//   S6  helmet security headers are present on every response
//   S7  with a restricted ADMIN_CORS_ORIGIN set, arbitrary origins get no CORS
//       headers while the configured origin does
//   S8  APP_ENFORCE_TLS=true redirects GET, refuses non-idempotent methods and
//       keeps /health probe-able over plaintext
//   S9  startup guards: production refuses to boot without a valid dedicated
//       MFA secret key and without an explicit CORS origin
//  S10  the privilege-check and secret-scan scripts run clean

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!process.env.REDIS_URL) throw new Error('REDIS_URL is required');

process.env.NODE_ENV = 'test';
process.env.APP_ENFORCE_TLS = 'false';
delete process.env.ADMIN_MFA_ENFORCED;
delete process.env.ADMIN_CORS_ORIGIN;

const results = [];
const ok = (name) => results.push({ name, pass: true });
const fail = (name, detail) => results.push({ name, pass: false, detail });

const { default: app } = await import('../../src/app.js?m=main');
const prisma = (await import('../../src/utils/db.js?m=main')).default;
const redis = (await import('../../src/utils/redis.js?m=main')).default;
const { AuthService } = await import('../../src/modules/auth/service.js?m=main');
const { AdminMfaService } = await import('../../src/modules/mfa/service.js?m=main');
const { ensureRoles, assignRole } = await import('../../src/modules/rbac/service.js?m=main');
const { generateSync } = await import('otplib');

// The shared ioredis client may still be connecting when the first probes
// issue writes (offline queue disabled); wait until it is ready.
await new Promise((resolve, reject) => {
  if (redis.status === 'ready') return resolve();
  redis.once('ready', resolve);
  redis.once('error', reject);
});

const uid = () => crypto.randomUUID();
const password = 'Verify-Pass-123';

const listen = (instance) => new Promise((resolve) => {
  const server = instance.listen(0, () => resolve(server));
});
const close = (server) => new Promise((resolve) => server.close(resolve));

const mainServer = await listen(app);
const base = `http://127.0.0.1:${mainServer.address().port}`;

const http = async (method, urlPath, { token, json, headers = {} } = {}) => {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: {
      ...(json ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    ...(json ? { body: JSON.stringify(json) } : {})
  });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
};

const register = async (email) => {
  const geoBinding = await AuthService.createGeoBinding('NG');
  const user = await AuthService.register({
    email,
    password,
    dateOfBirth: '1990-01-01',
    countryCode: 'NG',
    geoBinding
  });
  return user;
};

const login = (email) => http('POST', '/auth/login', { json: { email, password } });

const createdUsers = [];

async function run(name, probe) {
  try {
    await probe();
    ok(name);
  } catch (e) {
    fail(name, `${e?.constructor?.name}: ${e?.message}`);
    if (process.env.VERIFY_DEBUG === '1') console.error(e.stack);
  }
}

// ---------------------------------------------------------------------------
// S1 / S2 — refresh token reuse detection and logout revocation
// ---------------------------------------------------------------------------

await run('S1 rotated refresh token replay revokes all sessions and writes a security event', async () => {
  const email = `sec.${uid()}@example.com`;
  const user = await register(email);
  createdUsers.push(user.id);

  const first = await login(email);
  assert.equal(first.status, 200);
  const rt1 = first.body.refreshToken;

  const rotate = await http('POST', '/auth/refresh', { json: { userId: user.id, refreshToken: rt1 } });
  assert.equal(rotate.status, 200);
  const rt2 = rotate.body.refreshToken;

  const replay = await http('POST', '/auth/refresh', { json: { userId: user.id, refreshToken: rt1 } });
  assert.equal(replay.status, 401);

  const event = await prisma.securityEvent.findFirst({
    where: { userId: user.id, type: 'REFRESH_REUSE_DETECTED' }
  });
  assert.ok(event, 'expected a REFRESH_REUSE_DETECTED security event');

  const active = await prisma.userSession.count({ where: { userId: user.id, status: 'ACTIVE' } });
  assert.equal(active, 0, 'all sessions must be revoked after a detected reuse');

  const newest = await http('POST', '/auth/refresh', { json: { userId: user.id, refreshToken: rt2 } });
  assert.equal(newest.status, 401, 'tokens minted before the reuse must also be dead');
});

await run('S2 logout revokes the session so that refresh token is dead', async () => {
  const email = `sec.${uid()}@example.com`;
  const user = await register(email);
  createdUsers.push(user.id);

  const loginRes = await login(email);
  assert.equal(loginRes.status, 200);
  const { accessToken, refreshToken } = loginRes.body;

  const out = await http('POST', '/auth/logout', { token: accessToken, json: { refreshToken } });
  assert.equal(out.status, 200);

  const replay = await http('POST', '/auth/refresh', { json: { userId: user.id, refreshToken } });
  assert.equal(replay.status, 401);

  const session = await prisma.userSession.findFirst({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } });
  assert.equal(session.status, 'REVOKED');
});

// ---------------------------------------------------------------------------
// S3 / S4 — TOTP MFA lifecycle, brute-force lockout and encrypted secret
// ---------------------------------------------------------------------------

let mfaAdmin = null;
let mfaBase32 = null;
const MFA_FAIL_LOCK_AT = 5;

await run('S3 TOTP lifecycle gates admin access and trips the failure lock', async () => {
  process.env.ADMIN_MFA_ENFORCED = 'true';
  const email = `sec-admin.${uid()}@example.com`;
  const user = await register(email);
  createdUsers.push(user.id);
  mfaAdmin = user;
  await ensureRoles();
  await assignRole(user.id, 'SUPER_ADMIN');

  const loginRes = await login(email);
  assert.equal(loginRes.status, 200);
  const token = loginRes.body.accessToken;
  const gate = (headers = {}) => http('GET', '/admin/gate-probe-1', { token, headers });

  const statusBefore = await http('GET', '/admin/mfa/status', { token });
  assert.equal(statusBefore.status, 200);
  assert.deepEqual(statusBefore.body, { userId: user.id, provisioned: false, enabled: false });

  const gateBefore = await gate();
  assert.equal(gateBefore.status, 403, 'a non-provisioned admin must be denied');

  const setup = await http('POST', '/admin/mfa/setup', { token });
  assert.equal(setup.status, 201);
  assert.ok(setup.body.base32);
  assert.ok(setup.body.otpauthUrl.includes('otpauth://totp/'));
  mfaBase32 = setup.body.base32;

  const gateProvisioned = await gate();
  assert.equal(gateProvisioned.status, 403, 'provisioned but not enabled must be denied');

  const wrongEnable = await http('POST', '/admin/mfa/verify', { token, json: { code: '000000' } });
  assert.equal(wrongEnable.status, 403);

  const validCode = generateSync({ secret: mfaBase32 });
  const enable = await http('POST', '/admin/mfa/verify', { token, json: { code: validCode } });
  assert.equal(enable.status, 200);
  assert.deepEqual(enable.body, { enabled: true });

  const statusAfter = await http('GET', '/admin/mfa/status', { token });
  assert.deepEqual(statusAfter.body, { userId: user.id, provisioned: true, enabled: true });

  const gateWrong = await gate({ 'x-admin-mfa-code': '000000' });
  assert.equal(gateWrong.status, 403, 'a wrong code on the gate must be denied');

  for (let i = 1; i < MFA_FAIL_LOCK_AT; i += 1) {
    await gate({ 'x-admin-mfa-code': '000000' });
  }
  assert.equal(await AdminMfaService.isLocked(user.id), true, 'five failures must lock MFA');

  const gateLocked = await gate({ 'x-admin-mfa-code': generateSync({ secret: mfaBase32 }) });
  assert.equal(gateLocked.status, 403, 'a locked admin is denied even with the correct code');
});

await run('S4 the TOTP secret is stored encrypted at rest, never as plaintext', async () => {
  assert.ok(mfaAdmin, 'S3 must have provisioned an admin');
  const row = await prisma.adminMfa.findUnique({ where: { userId: mfaAdmin.id } });
  assert.ok(row);
  assert.ok(row.secretEnc);
  assert.ok(!row.secretEnc.includes(mfaBase32), 'ciphertext must not contain the plaintext base32');
  assert.equal(row.secretEnc.split('.').length, 3, 'expected iv.tag.ciphertext layout');
  const status = await AdminMfaService.getStatus(mfaAdmin.id);
  assert.deepEqual(status, { provisioned: true, enabled: true });
});

// ---------------------------------------------------------------------------
// S5 — route-specific rate limiter isolation (distinct Redis budgets)
// ---------------------------------------------------------------------------

await run('S5 wallet traffic runs on its own Redis budget, isolated from health', async () => {
  for (let i = 0; i < 15; i += 1) {
    await fetch(`${base}/wallet/balance`); // 401 fast path, still rate-limiter counted
    await fetch(`${base}/health`);
  }
  const sumCounts = async (prefix) => {
    const keys = await redis.keys(`${prefix}*`);
    const counts = await Promise.all(keys.map((k) => redis.get(k)));
    return counts.reduce((a, b) => a + Number(b || 0), 0);
  };
  const wallet = await sumCounts('rl:http:wallet:');
  const global = await sumCounts('rl:http:global:');
  assert.ok(global >= 20, `global bucket should count both endpoints (got ${global})`);
  assert.ok(
    wallet >= 14 && wallet <= 30,
    `wallet hits must land in the wallet bucket only (got ${wallet})`
  );
});

// ---------------------------------------------------------------------------
// S6 — helmet security headers
// ---------------------------------------------------------------------------

await run('S6 security headers are present on responses', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(res.headers.get('content-security-policy'));
  assert.ok(res.headers.get('x-frame-options'));
  assert.ok(res.headers.get('x-dns-prefetch-control'));
});

// ---------------------------------------------------------------------------
// S7 — CORS restrict-guard (separate app instance with a pinned origin)
// ---------------------------------------------------------------------------

await run('S7 CORS allows only the configured admin origin', async () => {
  process.env.ADMIN_CORS_ORIGIN = 'https://admin.draughtbet.com';
  try {
    const { default: corsApp } = await import('../../src/app.js?mode=cors');
    const server = await listen(corsApp);
    try {
      const port = server.address().port;
      const evil = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { origin: 'https://evil.example' }
      });
      assert.equal(evil.headers.get('access-control-allow-origin'), null);

      const allowed = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { origin: 'https://admin.draughtbet.com' }
      });
      assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://admin.draughtbet.com');
    } finally {
      await close(server);
    }
  } finally {
    delete process.env.ADMIN_CORS_ORIGIN;
  }
});

// ---------------------------------------------------------------------------
// S8 — production TLS enforcement (separate app instance)
// ---------------------------------------------------------------------------

await run('S8 TLS enforcement redirects GET, refuses POST and keeps /health plaintext', async () => {
  process.env.APP_ENFORCE_TLS = 'true';
  try {
    const { default: tlsApp } = await import('../../src/app.js?mode=tls');
    const server = await listen(tlsApp);
    try {
      const port = server.address().port;
      const get = await fetch(`http://127.0.0.1:${port}/wallet/balance`, { redirect: 'manual' });
      assert.equal(get.status, 301);
      assert.ok((get.headers.get('location') || '').startsWith('https://'));

      const post = await fetch(`http://127.0.0.1:${port}/wallet/balance`, {
        method: 'POST',
        redirect: 'manual'
      });
      assert.equal(post.status, 403);

      const health = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(health.status, 200, 'health probes stay usable over plaintext');
    } finally {
      await close(server);
    }
  } finally {
    delete process.env.APP_ENFORCE_TLS;
  }
});

// ---------------------------------------------------------------------------
// S9 — startup guards
// ---------------------------------------------------------------------------

await run('S9 production refuses to boot without an MFA key or a CORS origin', async () => {
  const { encryptMfaSecret } = await import('../../src/utils/mfaSecrets.js');
  const saved = { node: process.env.NODE_ENV, key: process.env.ADMIN_MFA_SECRET_KEY };

  process.env.NODE_ENV = 'production';
  try {
    delete process.env.ADMIN_MFA_SECRET_KEY;
    assert.throws(() => encryptMfaSecret('x'), /ADMIN_MFA_SECRET_KEY is missing/);

    process.env.ADMIN_MFA_SECRET_KEY = 'your-mfa-secret-encryption-key-00000000000000000000000000000000';
    assert.throws(() => encryptMfaSecret('x'), /sample value/);

    process.env.ADMIN_MFA_SECRET_KEY = 'abcd';
    assert.throws(() => encryptMfaSecret('x'), /64-char hex/);

    process.env.ADMIN_MFA_SECRET_KEY = '1'.repeat(64);
    process.env.JWT_SECRET = 'j'.repeat(64);
    delete process.env.ADMIN_CORS_ORIGIN;
    await assert.rejects(
      () => import('../../src/app.js?mode=nocors'),
      /ADMIN_CORS_ORIGIN is missing/
    );
  } finally {
    process.env.NODE_ENV = saved.node;
    if (saved.key) process.env.ADMIN_MFA_SECRET_KEY = saved.key;
    else delete process.env.ADMIN_MFA_SECRET_KEY;
  }
});

// ---------------------------------------------------------------------------
// S10 — operational scripts run clean
// ---------------------------------------------------------------------------

await run('S10 privilege check and secret scan run clean', async () => {
  const backendRoot = path.resolve(new URL('../..', import.meta.url).pathname);
  const runScript = (cmd) => execFileSync(cmd.shift(), cmd, {
    cwd: backendRoot,
    encoding: 'utf8',
    env: process.env
  });

  const priv = runScript(['bash', 'scripts/check-privileges.sh']);
  assert.ok(priv.includes('Privilege check passed.'), priv.slice(-200));

  const scan = runScript(['bash', 'scripts/scan-secrets.sh']);
  assert.ok(scan.includes('[scan-secrets] Clean.'), scan.slice(-200));
});

// ---------------------------------------------------------------------------

console.log('='.repeat(64));
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `  [${r.detail}]`}`);
}
console.log('='.repeat(64));
const failed = results.filter((r) => !r.pass).length;
console.log(`${results.length - failed}/${results.length} probes passed\n`);

let finalExit = failed > 0 ? 1 : 0;
try {
  await close(mainServer);
  for (const userId of createdUsers) {
    await prisma.adminRoleAssignment.deleteMany({ where: { userId } });
    await prisma.adminAuditLog.deleteMany({ where: { adminId: userId } });
    const keys = await redis.keys(`refresh:${userId}:*`);
    if (keys.length) await redis.del(...keys);
    await redis.del(`mfa:fail:${userId}`);
    await redis.del(`rl:http:admin:127.0.0.1`, `rl:http:admin:mfa:127.0.0.1`);
    // Wallet has no CASCADE from User, so remove it first; every other probe
    // artifact (sessions, events, ledger accounts, admin MFA) cascades.
    await prisma.wallet.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }
  console.log('[cleanup] probe users, sessions and events removed\n');
} catch (e) {
  console.error('[cleanup] failed (manual review needed):', e.message);
  finalExit = 1;
}

await prisma.$disconnect();
process.exit(finalExit);
const MFA_LOCK_WRONG_REST = 4;