// Seeds the fixtures the PR7 withdrawal screen drive needs, against a RUNNING
// backend pointed at the stand-in Paystack provider.
//
//   PAYSTACK_API_BASE=http://127.0.0.1:4010 PORT=3100 \
//     node --env-file=.env scripts/seed-withdrawal-drive.mjs
//
// Almost everything here goes through the real HTTP API — registration, the
// verification pass, the bank-account verification that calls the provider,
// and the ledger credit — so the screens are driven by the same code a player
// would hit. Two things are written straight to the database, because there is
// deliberately no endpoint for either:
//
//   * the staff account, since becoming an admin must never be self-service
//   * its FINANCE role, since role assignment is not player-reachable
//   * the geo binding, because /auth/geo-locate needs a reverse-geocode call
//     and this sandbox has no egress. The binding is minted with the backend's
//     own AuthService.createGeoBinding, so the key, TTL and one-time semantics
//     are the real ones — only the external geocoder is skipped.
//
// Everything after that (approve, begin-payout, the signed transfer webhook) is
// reached over HTTP by the drive test itself.
import prisma from '../src/utils/db.js';
import redis from '../src/utils/redis.js';
import { AuthService } from '../src/modules/auth/service.js';
import { ensureRoles, assignRole } from '../src/modules/rbac/service.js';
import { postDepositCredit } from '../src/services/ledgerService.js';

const API = process.env.DRIVE_API || 'http://127.0.0.1:3100/api/v1';
const API_ROOT = API.replace(/\/api\/v1$/, '');

const PLAYER = {
  email: 'withdraw.dev@draughtsarena.net',
  phone: '+2348000000001',
  username: 'withdrawdev',
  fullName: 'Amaka Obi',
  password: 'Draughts@Dev2026',
  dateOfBirth: '1994-04-11',
  countryCode: 'NG',
};

const UNVERIFIED = {
  email: 'withdraw.unverified@draughtsarena.net',
  phone: '+2348000000002',
  username: 'withdrawunv',
  fullName: 'Tunde Bakare',
  password: 'Draughts@Dev2026',
  dateOfBirth: '1991-09-02',
  countryCode: 'NG',
};

const STAFF = {
  email: 'finance.dev@draughtsarena.net',
  phone: '+2348000000009',
  username: 'financedev',
  fullName: 'Finance Operator',
  password: 'Draughts@Dev2026',
  dateOfBirth: '1990-01-01',
  countryCode: 'NG',
};

const START_BALANCE = 500000n; // 5,000.00 — the ledger rejects anything but a BigInt
const TOP_UP = 200000n; // 2,000.00 credited per run so a completed drive is repeatable
const BANK = { bankCode: '007', accountNumber: '0123456789' };

const call = async (method, path, { token, body, raw, idempotencyKey } = {}) => {
  const response = await fetch(`${raw ? API_ROOT : API}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body: json };
};

/**
 * /auth is limited to 5 attempts per IP per minute, and this seed needs a token
 * for three accounts, so a re-run used to lock itself out. Tokens are cached in
 * Redis for a fraction of their own lifetime instead.
 */
const login = async (email, password) => {
  const cacheKey = `drive:token:${email}`;
  const cached = redis ? await redis.get(cacheKey) : null;
  if (cached) {
    console.log(`seed: reusing cached token for ${email}`);
    return cached;
  }
  const res = await call('POST', '/auth/login', { body: { email, password } });
  if (res.status !== 200) {
    throw new Error(`login ${email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const token = res.body.data?.accessToken ?? res.body.accessToken;
  if (redis) await redis.set(cacheKey, token, 'EX', 20 * 60);
  return token;
};

/**
 * Registers through the real endpoint, but is happy to reuse an existing
 * account so the drive can be re-run without a database reset.
 */
const ensurePlayer = async (person) => {
  const existing = await prisma.user.findUnique({ where: { email: person.email } });
  if (existing) {
    console.log(`seed: ${person.email} already exists (id=${existing.id})`);
    return existing;
  }
  const binding = await AuthService.createGeoBinding(person.countryCode);
  if (!binding) {
    throw new Error(
      'could not mint a geo binding — Redis must be reachable, or /auth/geo-locate must work'
    );
  }
  const res = await call('POST', '/auth/register', { body: { ...person, geoBinding: binding } });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`register ${person.email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  console.log(`seed: registered ${person.email}`);
  return prisma.user.findUnique({ where: { email: person.email } });
};

/**
 * The withdrawal gates on kycStatus === 'VERIFIED'. The simulated provider is a
 * real endpoint that reaches that state, so the drive does not write the column.
 */
const ensureVerified = async (user, token) => {
  if (user.kycStatus === 'VERIFIED') {
    console.log(`seed: ${user.email} already verified`);
    return;
  }
  const res = await call('POST', '/verification/start', {
    token,
    body: { type: 'ID_DOCUMENT', providerName: 'simulated' },
  });
  console.log(
    `seed: verification for ${user.email} -> ${res.status} ${JSON.stringify(res.body?.status ?? res.body?.error ?? '')}`
  );
  const after = await prisma.user.findUnique({ where: { id: user.id } });
  if (after.kycStatus !== 'VERIFIED') {
    throw new Error(`${user.email} did not reach VERIFIED (got ${after.kycStatus})`);
  }
};

/**
 * Credits through the real ledger path so GET /wallet/balance agrees.
 * postDepositCredit is already idempotent on the reference, so a re-run does
 * not double-credit.
 */
const ensureFunded = async (user, amountMinorUnits) => {
  const reference = `drive-seed-${user.id}`;
  await prisma.wallet.create({ data: { userId: user.id } }).catch(() => {});
  await postDepositCredit(prisma, { userId: user.id, amountMinorUnits, reference });
  console.log(`seed: credited ${amountMinorUnits} to ${user.email} (ref ${reference})`);
};

/** A fresh reference every run, so repeated drives keep clearing the balance. */
const topUp = async (user, amountMinorUnits) => {
  const reference = `drive-topup-${user.id}-${Date.now()}`;
  await postDepositCredit(prisma, { userId: user.id, amountMinorUnits, reference });
  console.log(`seed: topped up ${amountMinorUnits} to ${user.email} (ref ${reference})`);
};

/**
 * Saves a bank account over HTTP so the provider is genuinely asked to resolve
 * the nuban and mint a recipient code — the app's "verifying" screen is only
 * honest if that round trip really happened.
 */
const ensureBankAccount = async (user, token) => {
  const existing = await prisma.bankAccount.findFirst({ where: { userId: user.id } });
  if (existing?.recipientRef) {
    console.log(
      `seed: ${user.email} already has ${existing.bankCode}/${maskOf(existing.accountNumber)} (recipient ${existing.recipientRef})`
    );
    return existing;
  }
  const res = await call('POST', '/me/bank-accounts', {
    token,
    body: BANK,
    // A run-scoped key: the endpoint enforces Idempotency-Key, and a fixed one
    // would replay a previous run's response instead of verifying anything.
    idempotencyKey: `drive-bank-${user.id}-${Date.now()}`,
  });
  if (res.status !== 200) {
    throw new Error(`bank account failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  // POST /me/bank-accounts answers {data:{...}} with the account itself under
  // data, not data.bankAccount. Read the payload the app reads.
  const account = res.body.data ?? res.body.bankAccount;
  if (!account?.maskedAccountNumber) {
    throw new Error(`bank account response unexpected: ${JSON.stringify(res.body)}`);
  }
  console.log(
    `seed: bank account for ${user.email} -> ${account.bankCode}/${account.maskedAccountNumber} verified=${account.verified}`
  );
  return account;
};

const maskOf = (accountNumber) => {
  const digits = String(accountNumber);
  return `******${digits.slice(-4)}`;
};

/**
 * The staff account is written directly, because there is no registration path
 * that grants admin and inventing one would be the actual security bug.
 */
const ensureStaff = async () => {
  await ensureRoles();
  const staff = await ensurePlayer(STAFF);
  const withAdmin = await prisma.user.update({
    where: { id: staff.id },
    data: { isAdmin: true },
  });
  // FINANCE carries withdrawals.process; isAdmin alone does not.
  await assignRole(staff.id, 'FINANCE', { assignedBy: staff.id });
  await assignRole(staff.id, 'SUPER_ADMIN', { assignedBy: staff.id });
  const roles = await prisma.adminRoleAssignment.findMany({
    where: { userId: staff.id },
    include: { role: true },
  });
  console.log(
    `seed: staff ${withAdmin.email} isAdmin=true roles=${roles.map((r) => r.role.name).join(',')}`
  );
  return staff;
};

const main = async () => {
  const player = await ensurePlayer(PLAYER);
  const unverified = await ensurePlayer(UNVERIFIED);
  const staff = await ensureStaff();

  const playerToken = await login(PLAYER.email, PLAYER.password);
  const unverifiedToken = await login(UNVERIFIED.email, UNVERIFIED.password);
  const staffToken = await login(STAFF.email, STAFF.password);

  await ensureVerified(player, playerToken);
  await ensureFunded(player, START_BALANCE);
  // Every completed drive permanently debits the ledger, so each run tops the
  // wallet up again rather than needing a database reset between recordings.
  await topUp(player, TOP_UP);

  // The gate screen needs a user who is eligible on every other axis, so the
  // only thing that can stop the withdrawal is the missing verification.
  const gateCheck = await call('GET', '/me/eligibility?action=WITHDRAW', {
    token: unverifiedToken,
  });
  console.log(
    `seed: unverified eligibility -> ${gateCheck.status} ${JSON.stringify(gateCheck.body?.eligibility ?? gateCheck.body)}`
  );

  await ensureBankAccount(player, playerToken);

  const balance = await call('GET', '/wallet/balance', { token: playerToken });
  console.log(`seed: player balance -> ${JSON.stringify(balance.body?.balance ?? balance.body)}`);

  const accounts = await call('GET', '/me/bank-accounts', { token: playerToken });
  console.log(`seed: player bank accounts -> ${JSON.stringify(accounts.body?.data ?? accounts.body)}`);

  const limits = await call('GET', '/me/limits', { token: playerToken });
  console.log(`seed: player limits -> ${JSON.stringify(limits.body?.data ?? limits.body)}`);

  const gated = await call('GET', '/me/eligibility?action=WITHDRAW', { token: playerToken });
  console.log(
    `seed: player eligibility -> ${gated.status} ${JSON.stringify(gated.body?.eligibility ?? gated.body)}`
  );
  console.log(`seed: staff token acquired for ${STAFF.email} (id=${staff.id})`);

  await prisma.$disconnect();
  if (redis) redis.disconnect();
};

main().catch(async (error) => {
  console.error('seed failed:', error.message);
  await prisma.$disconnect();
  if (redis) redis.disconnect();
  process.exit(1);
});
