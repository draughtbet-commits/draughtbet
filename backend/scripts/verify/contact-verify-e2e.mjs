#!/usr/bin/env node
// Real end-to-end verification of the contact-verify, password-recovery and
// sessions surface against a live dev server + Postgres + Redis.
//
// The server must be booted with DEV_OTP_MAILBOX=1 so issued codes are stashed
// in Redis (never logged — the mailbox is the retrieval path for tests).
//
// Usage:
//   DATABASE_URL=... REDIS_URL=... DEV_OTP_MAILBOX=1 PORT=4399 NODE_ENV=test \
//     node src/server.js &
//   node scripts/verify/contact-verify-e2e.mjs [baseUrl]
import Redis from 'ioredis';
import crypto from 'crypto';
import pg from 'pg';

const BASE_URL = process.argv[2] || 'http://127.0.0.1:4399';
if (!process.env.REDIS_URL) {
  console.error('REDIS_URL must be set so codes can be read from the dev mailbox.');
  process.exit(2);
}
const redis = new Redis(process.env.REDIS_URL);

const request = async (path, options = {}) => {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...options.headers
    }
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body };
};

let failures = 0;
const check = (name, condition, detail = '') => {
  const pass = Boolean(condition);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `  ${detail}`}`);
  if (!pass) failures++;
};

const health = await request('/health');
check('health 200', health.status === 200, `got ${health.status}`);
if (health.status !== 200) process.exit(2);

const email = `verify-e2e-${Date.now()}@example.com`;
const password1 = 'First-Password-1';
const password2 = 'Reset-Password-2';

const geoToken = crypto.randomUUID();
await redis.set(`geo:binding:${geoToken}`, 'NG', 'EX', 600);

const reg = await request('/api/v1/auth/register', {
  method: 'POST',
  body: JSON.stringify({
    email,
    password: password1,
    dateOfBirth: '1990-01-01',
    countryCode: 'NG',
    geoBinding: geoToken,
    deviceInfo: { platform: 'e2e' }
  })
});
check('register 201', reg.status === 201, `got ${reg.status} ${JSON.stringify(reg.body)}`);
check('register mints an access token', Boolean(reg.body?.accessToken), JSON.stringify(reg.body));

const login1 = await request('/api/v1/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email, password: password1 })
});
check('login (first password) 200', login1.status === 200, `got ${login1.status}`);
const { accessToken, refreshToken } = login1.body;
check('login mints tokens', Boolean(accessToken && refreshToken));

const auth = (token) => ({ Authorization: `Bearer ${token}` });

// --- contact verify: happy path -------------------------------------------
const start = await request('/api/v1/auth/verify/start', {
  method: 'POST',
  headers: auth(accessToken),
  body: JSON.stringify({ channel: 'email', destination: email })
});
check('verify/start 200', start.status === 200, `${start.status} ${JSON.stringify(start.body)}`);
const { challengeId, expiresInSeconds, resendAfterSeconds } = start.body?.data ?? {};
check('start returns challengeId', Boolean(challengeId));
check('start TTL window (300 expiry / 60 resend)', expiresInSeconds === 300 && resendAfterSeconds === 60,
  JSON.stringify({ expiresInSeconds, resendAfterSeconds }));

const code = await redis.get(`dev:otp-mail:${challengeId}`);
check('mailbox held the code (never logged)', Boolean(code && /^\d{6}$/.test(code)), `code=${code}`);

const wrong = await request('/api/v1/auth/verify/confirm', {
  method: 'POST',
  headers: auth(accessToken),
  body: JSON.stringify({ challengeId, code: '221144' })
});
check('verify/confirm wrong code 400 OTP_INVALID', wrong.status === 400 && wrong.body?.error?.code === 'OTP_INVALID',
  `${wrong.status} ${JSON.stringify(wrong.body)}`);

const confirm = await request('/api/v1/auth/verify/confirm', {
  method: 'POST',
  headers: auth(accessToken),
  body: JSON.stringify({ challengeId, code })
});
check('verify/confirm 200 verified', confirm.status === 200 && confirm.body?.data?.verified === true && confirm.body?.data?.channel === 'email',
  `${confirm.status} ${JSON.stringify(confirm.body)}`);

const replay = await request('/api/v1/auth/verify/confirm', {
  method: 'POST',
  headers: auth(accessToken),
  body: JSON.stringify({ challengeId, code })
});
check('verify/confirm replay rejected (409)', replay.status === 409, `${replay.status} ${JSON.stringify(replay.body)}`);

const mismatch = await request('/api/v1/auth/verify/start', {
  method: 'POST',
  headers: auth(accessToken),
  body: JSON.stringify({ channel: 'email', destination: 'elsewhere@example.com' })
});
check('verify/start destination mismatch 400', mismatch.status === 400 && mismatch.body?.error?.code === 'DESTINATION_MISMATCH',
  `${mismatch.status} ${JSON.stringify(mismatch.body)}`);

const resend = await request('/api/v1/auth/verify/start', {
  method: 'POST',
  headers: auth(accessToken),
  body: JSON.stringify({ channel: 'phone' })
});
check('verify/start the fresh user has no phone on file (400 NO_CONTACT_ON_FILE)',
  resend.status === 400 && resend.body?.error?.code === 'NO_CONTACT_ON_FILE',
  `${resend.status} ${JSON.stringify(resend.body)}`);

// --- forgot / reset password ----------------------------------------------
const forgot = await request('/api/v1/auth/forgot-password', {
  method: 'POST',
  body: JSON.stringify({ identifier: email })
});
check('forgot-password 200 accepted', forgot.status === 200 && forgot.body?.data?.accepted === true,
  `${forgot.status} ${JSON.stringify(forgot.body)}`);

// Read the reset challenge straight from the DB: mailbox keys are keyed by
// challengeId which we cannot guess, and a Redis scan cannot tell the verify
// challenge from the reset one.
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const { rows: [userRow] } = await pool.query(
  `SELECT id FROM "User" WHERE email = $1 LIMIT 1`,
  [email]
);
const { rows: [resetRow] } = await pool.query(
  `SELECT id AS "challengeId"
     FROM "VerificationChallenge"
    WHERE "userId" = $1 AND type = 'PASSWORD_RESET'
    ORDER BY "createdAt" DESC
    LIMIT 1`,
  [userRow?.id]
);
const resetCode = await redis.get(`dev:otp-mail:${resetRow?.challengeId}`);
check('reset challenge row created (PASSWORD_RESET)', Boolean(resetRow?.challengeId));
check('reset code stashed in mailbox', Boolean(resetCode && /^\d{6}$/.test(resetCode)), `code=${resetCode}`);

const reset = await request('/api/v1/auth/reset-password', {
  method: 'POST',
  body: JSON.stringify({ challengeId: resetRow.challengeId, code: resetCode, newPassword: password2 })
});
check('reset-password 200 {reset, sessionsRevoked}', reset.status === 200 && reset.body?.data?.reset === true && reset.body?.data?.sessionsRevoked === true,
  `${reset.status} ${JSON.stringify(reset.body)}`);

const loginOld = await request('/api/v1/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email, password: password1 })
});
check('old password rejected after reset', loginOld.status === 401, `${loginOld.status} ${JSON.stringify(loginOld.body)}`);

const loginNew = await request('/api/v1/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email, password: password2 })
});
check('new password accepted + tokens issued', loginNew.status === 200 && Boolean(loginNew.body?.accessToken),
  `${loginNew.status} ${JSON.stringify(loginNew.body)}`);

// --- sessions list / revoke -----------------------------------------------
const token2 = loginNew.body.accessToken;
const sessions = await request('/api/v1/me/sessions', { headers: auth(token2) });
check('me/sessions 200', sessions.status === 200 && Array.isArray(sessions.body?.data), `${sessions.status} ${JSON.stringify(sessions.body)}`);
const list = sessions.body?.data ?? [];
check('exactly one current + active session after reset revoke-all',
  list.length === 1 && list[0].current === true, JSON.stringify(list));

const revoke = await request('/api/v1/me/sessions/does-not-exist', { method: 'DELETE', headers: auth(token2) });
check('revoke missing session 404', revoke.status === 404, `${revoke.status} ${JSON.stringify(revoke.body)}`);

// Second device login -> two sessions -> revoke the old one.
const loginNew2 = await request('/api/v1/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email, password: password2 })
});
const token3 = loginNew2.body.accessToken;
const sessions2 = await request('/api/v1/me/sessions', { headers: auth(token3) });
const list2 = sessions2.body?.data ?? [];
check('two active sessions after second login', list2.length === 2, JSON.stringify(list2));
const otherSession = list2.find((s) => !s.current);
const del = await request(`/api/v1/me/sessions/${otherSession.sessionId}`, { method: 'DELETE', headers: auth(token3) });
check('revoke other-device session 200', del.status === 200 && del.body?.data?.revoked === true, `${del.status} ${JSON.stringify(del.body)}`);

const sessions3 = await request('/api/v1/me/sessions', { headers: auth(token3) });
const list3 = sessions3.body?.data ?? [];
check('only the current session remains after revoke', list3.length === 1 && list3[0].current === true, JSON.stringify(list3));

await redis.quit();
console.log(failures === 0 ? '\nE2E verification: ALL PASS' : `\nE2E verification: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);