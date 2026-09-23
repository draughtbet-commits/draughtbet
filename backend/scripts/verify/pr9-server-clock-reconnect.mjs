// PR 9 — Server clock + reconnect deep verification (real Socket.IO + PostgreSQL + Redis)
//
// PR 9 makes the server clock the single source of truth for turn time, exposes
// an authoritative `clock.sync`, records durable connection evidence, snapshots
// a configurable disconnect grace, and rebuilds the live projection from the
// durable move log after a reconnect or restart. This harness drives the real
// production wiring end to end.
//
//   P1  match.join returns the canonical clock + snapshotted grace
//   P2  move.accepted / move_applied carry the official clock and the durable
//       projection's turnStartedAt matches the emitted turnStartedAtServer
//   P3  clock.sync answers with the authoritative server time and echoes the
//       client timestamp without ever trusting a client clock
//   P4  clock.sync is strict: an unknown "server time" field and a
//       non-participant are both refused
//   P5  exit gate: a turn whose server deadline passed is expired and forfeited
//       regardless of what the client claims its clock is
//   P6  a stale (behind-version) Redis projection is rebuilt from the durable
//       log on reconnect
//   P7  a missing Redis projection is rebuilt from the durable log on reconnect
//   P8  an un-replayable durable log is never projected
//   P9  boot recovery rehydrates a missing projection and re-points participants
//   P10 boot recovery re-arms a pending disconnect with a fresh grace window
//   P11 only the user's LAST socket arms the grace timer and warns the opponent
//   P12 reconnecting within grace clears the timer and records RECONNECTED
//   P13 the grace value is pinned per match, ignoring a later env change
//   P14 disconnect sweep forfeits the timed-out player and records FORFEIT
//   P15 both players timed out past grace settles as a draw, not a forfeit
//   P16 sweep never settles a match that is no longer live
//   P17 sweep is suspended entirely while GAME_FORFEIT_SUSPENDED is set
//   P18 closed book: every LedgerTransaction still nets zero
//
// Run:  timeout 300 node --env-file=.env scripts/verify/pr9-server-clock-reconnect.mjs

import assert from 'node:assert/strict';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import { io as createSocketClient } from 'socket.io-client';
import prisma from '../../src/utils/db.js';
import redis from '../../src/utils/redis.js';
import { initSocketServer } from '../../src/sockets/index.js';
import { getJwtSecret } from '../../src/utils/jwtEnv.js';
import { debitStakes } from '../../src/services/matchService.js';
import { finalizeMatchActivation } from '../../src/services/gameActivationService.js';
import { reconcileRedisWithDurable, recoverLiveGames } from '../../src/sockets/gameRecovery.js';
import { processDisconnectSweep } from '../../src/jobs/disconnectSweep.js';
import {
  createInitialBoard,
  getLegalMoves,
  applyMove,
  COLOR_WHITE,
  COLOR_BLACK
} from '../../src/modules/engine/index.js';
import {
  ensureUserAccounts,
  ensureSystemAccount,
  postLedgerTransaction
} from '../../src/services/ledgerService.js';

const socketServer = http.createServer();
socketServer.listen(0);
initSocketServer(socketServer);
const SOCKET_PORT = socketServer.address().port;
const SOCKET_URL = `http://127.0.0.1:${SOCKET_PORT}`;

const state = { users: [], matches: [], clients: [] };
const results = [];

const ok = (name, detail = '') => results.push({ name, pass: true, detail });
const fail = (name, detail) => results.push({ name, pass: false, detail });

async function run(name, probe) {
  try {
    await probe();
  } catch (e) {
    fail(name, `${e?.constructor?.name}: ${e?.message}`);
    if (process.env.VERIFY_DEBUG === '1') console.error(e.stack);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 6000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(interval);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

async function postOpeningBalance(wallet, amountMinorUnits) {
  await prisma.$transaction(async (tx) => {
    const accounts = await ensureUserAccounts(tx, wallet.userId, wallet.currency ?? 'NGN');
    const clearing = await ensureSystemAccount(tx, 'SYSTEM_OPENING_CLEARING', wallet.currency ?? 'NGN');
    await postLedgerTransaction(tx, {
      type: 'ADJUSTMENT',
      description: 'PR9 verify opening balance',
      idempotencyKey: `pr9-opening:${wallet.id}`,
      metadata: { walletId: wallet.id, source: 'pr9-verify' },
      entries: [
        { accountId: clearing.id, amountMinorUnits: -amountMinorUnits },
        { accountId: accounts.PLAYER_AVAILABLE.id, amountMinorUnits: amountMinorUnits }
      ]
    });
  });
}

async function makeUser(suffix, balance = 50000000n) {
  const user = await prisma.user.create({
    data: {
      email: `verify-pr9-${Date.now()}-${Math.random().toString(36).slice(2)}-${suffix}@test.local`,
      passwordHash: 'x',
      tier: 'PRO',
      kycStatus: 'VERIFIED',
      countryCode: 'NG',
      eligibility: {
        create: { countryCode: 'NG', countryAllowed: true, ageVerified: true }
      }
    }
  });
  const wallet = await prisma.wallet.create({ data: { userId: user.id } });
  await postOpeningBalance(wallet, balance);
  state.users.push(user.id);
  return user;
}

async function makeMatch(p1, p2, stake = 1000000n) {
  const match = await debitStakes(p1.id, p2.id, stake, 'PRO');
  const outbox = await prisma.gameOutbox.findFirst({ where: { matchId: match.id } });
  await finalizeMatchActivation(outbox.id);
  state.matches.push(match.id);
  return match;
}

// ---------------------------------------------------------------------------
// Socket helpers
// ---------------------------------------------------------------------------

function connectClient(userId, { token = userId ? authed(userId) : undefined } = {}) {
  const client = createSocketClient(SOCKET_URL, {
    auth: token ? { token } : {},
    transports: ['websocket'],
    reconnection: false
  });
  state.clients.push(client);
  return client;
}

const once = (client, event, timeout = 6000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeout);
    client.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

async function connectAndJoin(userId, matchId) {
  const client = connectClient(userId);
  await once(client, 'connect');
  const statePromise = once(client, 'match.state');
  client.emit('match.join', { matchId });
  const snapshot = await statePromise;
  return { client, snapshot };
}

async function closeOne(client, waitMs = 300) {
  try {
    client.close();
  } catch {
    // already closed
  }
  await sleep(waitMs);
}

const authed = (userId) => jwt.sign({ userId }, getJwtSecret(), { expiresIn: '1h' });

const moveByIndex = (board, turn, index = 0) => getLegalMoves(board, turn)[index];
const firstClockMove = () => {
  const board = createInitialBoard();
  const move = moveByIndex(board, COLOR_WHITE, 0);
  return { board, move, path: move.path ?? [move.from, move.to] };
};

const playFirstMove = async (client, matchId, clientMoveId) => {
  const { board, move, path } = firstClockMove();
  const acceptedP = once(client, 'move.accepted');
  const appliedP = once(client, 'move_applied');
  client.emit('move.submit', {
    matchId,
    clientMoveId,
    expectedStateVersion: 0,
    from: move.from,
    path
  });
  const [accepted, applied] = await Promise.all([acceptedP, appliedP]);
  return { move, accepted, applied, boardAfter: applyMove(board, move).newBoard };
};

// ---------------------------------------------------------------------------
// P1 — canonical clock + grace on join
// ---------------------------------------------------------------------------

const p1 = await makeUser('p1a');
const p2 = await makeUser('p2a');

await run('P1 match.join returns the canonical clock and snapshotted grace', async () => {
  const match = await makeMatch(p1, p2);
  const { client, snapshot } = await connectAndJoin(p1.id, match.id);

  assert.equal(snapshot.matchId, match.id);
  assert.equal(snapshot.version, '0');
  assert.ok(Number.isFinite(snapshot.serverNowMs), 'serverNowMs must be present');
  assert.ok(Math.abs(snapshot.serverNowMs - Date.now()) < 5000, 'serverNowMs must be real server time');
  assert.ok(snapshot.turnStartedAtServer > 0, 'turnStartedAtServer must be set');
  assert.ok(snapshot.deadlineAt > snapshot.serverNowMs, 'deadline must be in the future');
  assert.ok(snapshot.remainingMs > 0 && snapshot.remainingMs <= snapshot.timeControlSeconds * 1000);
  assert.equal(snapshot.disconnectGraceMs, 60000, 'default grace must be snapshotted');

  p1.match = match;
  p1.client = client;
  ok('P1 match.join returns the canonical clock and snapshotted grace');
});

// ---------------------------------------------------------------------------
// P2 — accepted move carries the official clock, matching durable projection
// ---------------------------------------------------------------------------

await run('P2 move.accepted carries the official clock, matching the durable turn start', async () => {
  const { client: blackClient } = await connectAndJoin(p2.id, p1.match.id);
  p2.client = blackClient;

  const { move, accepted, applied } = await playFirstMove(p1.client, p1.match.id, 'pr9_p2_white_0001');

  assert.equal(accepted.clientMoveId, 'pr9_p2_white_0001');
  assert.equal(accepted.replayed, false);
  assert.ok(Number.isFinite(accepted.serverNowMs), 'accepted must carry serverNowMs');
  assert.equal(accepted.turnStartedAtServer, applied.turnStartedAtServer,
    'both protocol shapes must agree on the turn start');
  assert.equal(accepted.turnStartedAtServer, accepted.serverNowMs,
    'the next turn opens at the same server instant the move landed');
  assert.ok(accepted.remainingMs > 0, 'the next turn must have remaining time');
  assert.ok(accepted.remainingMs <= accepted.deadlineAt - accepted.serverNowMs + 1,
    'remaining time must be derived from the server deadline');

  const projection = await prisma.matchGameState.findUnique({ where: { matchId: p1.match.id } });
  assert.equal(projection.stateVersion, 1);
  assert.equal(projection.turnStartedAt.getTime(), accepted.turnStartedAtServer,
    'durable turnStartedAt must equal the emitted official turn start');

  p1.move = move;
  ok('P2 move.accepted carries the official clock, matching the durable turn start');
});

// ---------------------------------------------------------------------------
// P3 — clock.sync is server-authoritative
// ---------------------------------------------------------------------------

await run('P3 clock.sync returns server time and never trusts a client clock', async () => {
  const clientSentAt = Date.now();
  const syncP = once(p1.client, 'clock.sync');
  p1.client.emit('clock.sync', { matchId: p1.match.id, clientSentAt });
  const sync = await syncP;

  assert.equal(sync.matchId, p1.match.id);
  assert.equal(sync.clientSentAt, clientSentAt);
  assert.ok(Math.abs(sync.serverNowMs - Date.now()) < 5000, 'serverNowMs must be real server time');
  assert.equal(sync.version, '1');
  assert.equal(sync.currentTurn, 'BLACK');
  assert.ok(sync.deadlineAt > sync.serverNowMs);
  assert.ok(sync.remainingMs > 0 && sync.remainingMs <= sync.timeControlSeconds * 1000);

  // A phone whose clock is ten hours fast cannot move the server clock.
  const phoneNow = Date.now() + 10 * 3600 * 1000;
  const syncP2 = once(p1.client, 'clock.sync');
  p1.client.emit('clock.sync', { matchId: p1.match.id, clientSentAt: phoneNow });
  const sync2 = await syncP2;
  assert.equal(sync2.clientSentAt, phoneNow);
  assert.ok(sync2.serverNowMs < phoneNow - 3600 * 1000,
    'the server must never echo a client clock as its own');
  assert.ok(sync2.remainingMs <= sync2.timeControlSeconds * 1000);

  ok('P3 clock.sync returns server time and never trusts a client clock');
});

// ---------------------------------------------------------------------------
// P4 — clock.sync strictness
// ---------------------------------------------------------------------------

await run('P4 clock.sync refuses extra time fields and non-participants', async () => {
  const outsider = await makeUser('p4outsider');
  const outsiderClient = connectClient(outsider.id);
  await once(outsiderClient, 'connect');
  const outsiderErrP = once(outsiderClient, 'error');
  outsiderClient.emit('clock.sync', { matchId: p1.match.id });
  const outsiderErr = await outsiderErrP;
  assert.equal(outsiderErr.message, 'Not authorized');

  const malformedErrP = once(p1.client, 'error');
  p1.client.emit('clock.sync', { matchId: p1.match.id, serverNowMs: 9999999999999 });
  const malformedErr = await malformedErrP;
  assert.equal(malformedErr.message, 'Invalid payload');

  await closeOne(outsiderClient);
  ok('P4 clock.sync refuses extra time fields and non-participants');
});

// ---------------------------------------------------------------------------
// P5 — exit gate: the official timeout ignores the client clock
// ---------------------------------------------------------------------------

await run('P5 exit gate: a passed server deadline expires and forfeits on time', async () => {
  const p3 = await makeUser('p5a');
  const p4 = await makeUser('p5b');
  const match = await makeMatch(p3, p4);
  const { client: white } = await connectAndJoin(p3.id, match.id);
  await connectAndJoin(p4.id, match.id);

  // The client claims (via clock.sync) that it has ten hours of turn time left.
  const phoneNow = Date.now() + 10 * 3600 * 1000;
  const syncP = once(white, 'clock.sync');
  white.emit('clock.sync', { matchId: match.id, clientSentAt: phoneNow });
  await syncP;

  // The server clock says otherwise: the deadline already passed.
  await redis.hset(`match:${match.id}`, { deadlineAt: String(Date.now() - 1000) });

  const move = moveByIndex(createInitialBoard(), COLOR_WHITE, 0);
  const rejectedP = once(white, 'move.rejected');
  white.emit('move.submit', {
    matchId: match.id,
    clientMoveId: 'pr9_p5_white_0001',
    expectedStateVersion: 0,
    from: move.from,
    to: move.to
  });
  const rejected = await rejectedP;
  assert.equal(rejected.code, 'turn_expired');

  const settled = await waitFor(async () => {
    const m = await prisma.match.findUnique({ where: { id: match.id } });
    return m?.status === 'SETTLED' ? m : null;
  });
  assert.ok(settled, 'a timed-out turn must settle the match');
  assert.equal(settled.winnerId, p4.id, 'the connected opponent wins on the clock');

  const rows = await prisma.matchMove.count({ where: { matchId: match.id } });
  assert.equal(rows, 0, 'an expired move must never be durably logged');

  ok('P5 exit gate: a passed server deadline expires and forfeits on time');
});

// ---------------------------------------------------------------------------
// P6 — stale Redis projection rebuilt from the durable log
// ---------------------------------------------------------------------------

await run('P6 a stale Redis projection is rebuilt from the durable log on reconnect', async () => {
  const p5 = await makeUser('p6a');
  const p6 = await makeUser('p6b');
  const match = await makeMatch(p5, p6);
  const { client: white } = await connectAndJoin(p5.id, match.id);
  const { client: black } = await connectAndJoin(p6.id, match.id);

  const { boardAfter } = await playFirstMove(white, match.id, 'pr9_p6_white_0001');

  // Force Redis behind the durable projection (board reset, version 0).
  await redis.hset(`match:${match.id}`, {
    board: JSON.stringify(createInitialBoard()),
    currentTurn: COLOR_WHITE,
    currentTurnUserId: p5.id,
    moveCount: '0',
    version: '0'
  });

  const { client: white2, snapshot } = await connectAndJoin(p5.id, match.id);
  assert.equal(snapshot.version, '1', 'the durable version must win');
  assert.deepEqual(snapshot.board, boardAfter, 'the replayed board must win');
  assert.equal(snapshot.currentTurn, 'BLACK');

  const live = await redis.hgetall(`match:${match.id}`);
  assert.equal(live.version, '1');
  assert.deepEqual(JSON.parse(live.board), boardAfter);

  await closeOne(white);
  await closeOne(black);
  await closeOne(white2);
  ok('P6 a stale Redis projection is rebuilt from the durable log on reconnect');
});

// ---------------------------------------------------------------------------
// P7 — missing Redis projection rebuilt from the durable log
// ---------------------------------------------------------------------------

await run('P7 a missing Redis projection is rebuilt from the durable log on reconnect', async () => {
  const p7 = await makeUser('p7a');
  const p8 = await makeUser('p7b');
  const match = await makeMatch(p7, p8);
  const { client: white } = await connectAndJoin(p7.id, match.id);
  await connectAndJoin(p8.id, match.id);

  const { boardAfter } = await playFirstMove(white, match.id, 'pr9_p7_white_0001');

  await redis.del(`match:${match.id}`);
  assert.equal(await redis.exists(`match:${match.id}`), 0);

  const { client: white2, snapshot } = await connectAndJoin(p7.id, match.id);
  assert.equal(snapshot.version, '1');
  assert.deepEqual(snapshot.board, boardAfter);
  assert.ok(Array.isArray(snapshot.legalMoves) && snapshot.legalMoves.length > 0);
  assert.equal(await redis.exists(`match:${match.id}`), 1, 'join must rebuild the projection');

  await closeOne(white);
  await closeOne(white2);
  ok('P7 a missing Redis projection is rebuilt from the durable log on reconnect');
});

// ---------------------------------------------------------------------------
// P8 — an un-replayable durable log is never projected
// ---------------------------------------------------------------------------

await run('P8 an un-replayable durable log is never projected', async () => {
  const p9 = await makeUser('p8a');
  const p10 = await makeUser('p8b');
  const match = await makeMatch(p9, p10);
  const { client: white } = await connectAndJoin(p9.id, match.id);
  await connectAndJoin(p10.id, match.id);
  await playFirstMove(white, match.id, 'pr9_p8_white_0001');

  await prisma.matchMove.updateMany({
    where: { matchId: match.id },
    data: { fromSquare: 1, toSquare: 2, path: [1, 2] }
  });
  await redis.del(`match:${match.id}`);

  const rebuilt = await reconcileRedisWithDurable(match.id);
  assert.equal(rebuilt, null, 'an un-replayable log must not be served');
  assert.equal(await redis.exists(`match:${match.id}`), 0, 'no bogus projection may be written');

  await closeOne(white);
  ok('P8 an un-replayable durable log is never projected');
});

// ---------------------------------------------------------------------------
// P9 — boot recovery rehydrates a missing projection and re-points
// ---------------------------------------------------------------------------

await run('P9 boot recovery rehydrates a missing projection and re-points participants', async () => {
  const p11 = await makeUser('p9a');
  const p12 = await makeUser('p9b');
  const match = await makeMatch(p11, p12);
  const { client: white } = await connectAndJoin(p11.id, match.id);
  await connectAndJoin(p12.id, match.id);
  const { boardAfter } = await playFirstMove(white, match.id, 'pr9_p9_white_0001');

  await redis.del(`match:${match.id}`);
  await redis.del(`user:${p11.id}:activeMatch`);
  await redis.del(`user:${p12.id}:activeMatch`);

  const recovery = await recoverLiveGames();
  assert.ok(recovery.scanned >= 1);

  const live = await redis.hgetall(`match:${match.id}`);
  assert.ok(Object.keys(live).length > 0, 'the projection must be rebuilt');
  assert.deepEqual(JSON.parse(live.board), boardAfter);
  assert.equal(await redis.get(`user:${p11.id}:activeMatch`), match.id);
  assert.equal(await redis.get(`user:${p12.id}:activeMatch`), match.id);

  await closeOne(white);
  ok('P9 boot recovery rehydrates a missing projection and re-points participants');
});

// ---------------------------------------------------------------------------
// P10 — boot recovery re-arms a pending disconnect
// ---------------------------------------------------------------------------

await run('P10 boot recovery re-arms a pending disconnect with a fresh grace', async () => {
  const p13 = await makeUser('p10a');
  const p14 = await makeUser('p10b');
  const match = await makeMatch(p13, p14);
  await redis.zadd('disconnects', Date.now() - 1000, `${match.id}:${p13.id}`);

  await recoverLiveGames();

  const score = await redis.zscore('disconnects', `${match.id}:${p13.id}`);
  assert.ok(score !== null, 'the pending entry must survive an outage');
  assert.ok(Number(score) > Date.now(), 'a restart must grant a fresh grace window');
  await redis.zrem('disconnects', `${match.id}:${p13.id}`);
  ok('P10 boot recovery re-arms a pending disconnect with a fresh grace');
});

// ---------------------------------------------------------------------------
// P11 — only the last socket arms the grace
// ---------------------------------------------------------------------------

let lastSocketProbe = null;

await run('P11 only the last socket arms the grace and warns the opponent', async () => {
  const p15 = await makeUser('p11a');
  const p16 = await makeUser('p11b');
  const match = await makeMatch(p15, p16);

  const tab1 = connectClient(p15.id);
  await once(tab1, 'connect');
  tab1.emit('match.join', { matchId: match.id });
  await once(tab1, 'match.state');

  const tab2 = connectClient(p15.id);
  await once(tab2, 'connect');
  tab2.emit('match.join', { matchId: match.id });
  await once(tab2, 'match.state');

  const { client: opponent } = await connectAndJoin(p16.id, match.id);

  await closeOne(tab1);
  assert.equal(await redis.zscore('disconnects', `${match.id}:${p15.id}`), null,
    'closing a second tab must not arm the grace');

  const warnedP = once(opponent, 'opponent_disconnected');
  await closeOne(tab2);
  const warned = await warnedP;
  assert.equal(warned.userId, p15.id);
  assert.equal(warned.gracePeriodMs, 60000);

  const score = await redis.zscore('disconnects', `${match.id}:${p15.id}`);
  assert.ok(score !== null && Number(score) > Date.now(), 'the last socket must arm the grace');

  const evidence = await prisma.matchConnectionEvent.count({
    where: { matchId: match.id, userId: p15.id, state: 'DISCONNECTED' }
  });
  assert.ok(evidence >= 1, 'a durable DISCONNECTED event must be recorded');

  lastSocketProbe = { userId: p15.id, match, opponent };
  ok('P11 only the last socket arms the grace and warns the opponent');
});

// ---------------------------------------------------------------------------
// P12 — reconnect within grace clears the timer
// ---------------------------------------------------------------------------

await run('P12 reconnecting within grace clears the timer and records RECONNECTED', async () => {
  const { userId, match, opponent } = lastSocketProbe;
  const reconnectedP = once(opponent, 'opponent_reconnected');
  const { client: back } = await connectAndJoin(userId, match.id);
  const reconnected = await reconnectedP;
  assert.equal(reconnected.userId, userId);
  assert.equal(await redis.zscore('disconnects', `${match.id}:${userId}`), null,
    'a reconnect must clear the grace entry');

  const evidence = await prisma.matchConnectionEvent.count({
    where: { matchId: match.id, userId, state: 'RECONNECTED' }
  });
  assert.ok(evidence >= 1, 'a durable RECONNECTED event must be recorded');

  await closeOne(back);
  await closeOne(opponent);
  ok('P12 reconnecting within grace clears the timer and records RECONNECTED');
});

// ---------------------------------------------------------------------------
// P13 — grace snapshot is pinned per match
// ---------------------------------------------------------------------------

await run('P13 the per-match grace snapshot ignores a later env change', async () => {
  const previous = process.env.DISCONNECT_GRACE_MS;
  process.env.DISCONNECT_GRACE_MS = '45000';

  const p17 = await makeUser('p13a');
  const p18 = await makeUser('p13b');
  const match = await makeMatch(p17, p18);

  const { client: a } = await connectAndJoin(p17.id, match.id);
  const { client: b } = await connectAndJoin(p18.id, match.id);

  process.env.DISCONNECT_GRACE_MS = '90000';

  const warnedP = once(b, 'opponent_disconnected');
  await closeOne(a);
  const warned = await warnedP;
  assert.equal(warned.gracePeriodMs, 45000,
    'the match must keep the grace snapshotted at game start');

  const reconnectedP = once(b, 'opponent_reconnected');
  const { client: back } = await connectAndJoin(p17.id, match.id);
  await reconnectedP;
  await redis.zrem('disconnects', `${match.id}:${p17.id}`);

  if (previous === undefined) delete process.env.DISCONNECT_GRACE_MS;
  else process.env.DISCONNECT_GRACE_MS = previous;

  await closeOne(back);
  await closeOne(b);
  ok('P13 the per-match grace snapshot ignores a later env change');
});

// ---------------------------------------------------------------------------
// P14 — disconnect sweep forfeits the timed-out player
// ---------------------------------------------------------------------------

await run('P14 disconnect sweep forfeits the timed-out player with durable evidence', async () => {
  const p19 = await makeUser('p14a');
  const p20 = await makeUser('p14b');
  const match = await makeMatch(p19, p20);

  await redis.zadd('disconnects', Date.now() - 1000, `${match.id}:${p19.id}`);
  const result = await processDisconnectSweep();
  assert.ok(result.processed >= 1, 'the expired entry must be processed');
  assert.equal(result.suspended, false);

  const settled = await waitFor(async () => {
    const m = await prisma.match.findUnique({ where: { id: match.id } });
    return m?.status === 'SETTLED' ? m : null;
  });
  assert.ok(settled, 'the sweep must settle the match');
  assert.equal(settled.winnerId, p20.id, 'the connected opponent wins');

  const forfeit = await prisma.gameEvent.findFirst({
    where: { matchId: match.id, type: 'FORFEIT' }
  });
  assert.ok(forfeit, 'a durable FORFEIT event must be recorded');
  assert.equal(forfeit.payload.reason, 'forfeit_disconnect');
  assert.equal(forfeit.playerId, p19.id);

  ok('P14 disconnect sweep forfeits the timed-out player with durable evidence');
});

// ---------------------------------------------------------------------------
// P15 — both disconnected past grace is a draw
// ---------------------------------------------------------------------------

await run('P15 both players timed out past grace settles as a draw', async () => {
  const p21 = await makeUser('p15a');
  const p22 = await makeUser('p15b');
  const match = await makeMatch(p21, p22);

  await redis.zadd('disconnects', Date.now() - 1000, `${match.id}:${p21.id}`);
  await redis.zadd('disconnects', Date.now() - 1000, `${match.id}:${p22.id}`);
  await processDisconnectSweep();

  const settled = await waitFor(async () => {
    const m = await prisma.match.findUnique({ where: { id: match.id } });
    return m?.status === 'SETTLED' ? m : null;
  });
  assert.ok(settled, 'the sweep must settle the match');
  assert.equal(settled.winnerId, null, 'a mutual disconnect is not a forfeit win');

  const forfeit = await prisma.gameEvent.findFirst({
    where: { matchId: match.id, type: 'FORFEIT' }
  });
  assert.ok(forfeit);
  assert.equal(forfeit.payload.reason, 'both_disconnected');

  ok('P15 both players timed out past grace settles as a draw');
});

// ---------------------------------------------------------------------------
// P16 — sweep validity: never settle a non-live match
// ---------------------------------------------------------------------------

await run('P16 sweep never settles a match that is no longer live', async () => {
  const p23 = await makeUser('p16a');
  const p24 = await makeUser('p16b');
  const match = await makeMatch(p23, p24);
  await prisma.match.update({ where: { id: match.id }, data: { status: 'SETTLED' } });

  await redis.zadd('disconnects', Date.now() - 1000, `${match.id}:${p23.id}`);
  const result = await processDisconnectSweep();
  assert.equal(result.processed, 0, 'a non-live match must not be settled by the sweep');

  const forfeits = await prisma.gameEvent.count({
    where: { matchId: match.id, type: 'FORFEIT' }
  });
  assert.equal(forfeits, 0);

  ok('P16 sweep never settles a match that is no longer live');
});

// ---------------------------------------------------------------------------
// P17 — forfeits suspended during an incident
// ---------------------------------------------------------------------------

await run('P17 sweep is suspended entirely while forfeits are disabled', async () => {
  process.env.GAME_FORFEIT_SUSPENDED = 'true';
  const result = await processDisconnectSweep();
  delete process.env.GAME_FORFEIT_SUSPENDED;

  assert.deepEqual(result, { processed: 0, suspended: true });
  ok('P17 sweep is suspended entirely while forfeits are disabled');
});

// ---------------------------------------------------------------------------
// Cleanup: drop authoritative state before closing sockets so disconnect
// handlers do not re-arm grace for the probe matches.
// ---------------------------------------------------------------------------

for (const client of state.clients) {
  try {
    client.close();
  } catch {
    // already closed
  }
}
await sleep(300);

for (const matchId of state.matches) {
  await redis.del(`match:${matchId}`);
}
for (const userId of state.users) {
  await redis.del(`user:${userId}:activeMatch`);
}
for (const matchId of state.matches) {
  for (const userId of state.users) {
    await redis.zrem('disconnects', `${matchId}:${userId}`);
  }
}

await prisma.matchMove.deleteMany({ where: { matchId: { in: state.matches } } });
await prisma.matchGameState.deleteMany({ where: { matchId: { in: state.matches } } });
await prisma.gameEvent.deleteMany({ where: { matchId: { in: state.matches } } });
await prisma.matchConnectionEvent.deleteMany({ where: { matchId: { in: state.matches } } });
await prisma.gameStateSnapshot.deleteMany({ where: { matchId: { in: state.matches } } });
await prisma.match.deleteMany({ where: { id: { in: state.matches } } });
await prisma.wallet.deleteMany({ where: { userId: { in: state.users } } });
await prisma.ledgerTransaction.deleteMany({
  where: {
    OR: [
      { relatedMatchId: { in: state.matches } },
      { metadata: { path: ['source'], equals: 'pr9-verify' } }
    ]
  }
});
await prisma.notification.deleteMany({ where: { userId: { in: state.users } } });
await prisma.user.deleteMany({ where: { id: { in: state.users } } });

// ---------------------------------------------------------------------------
// P18 — closed book
// ---------------------------------------------------------------------------

await run('P18 closed book: every LedgerTransaction still nets zero', async () => {
  const all = await prisma.ledgerTransaction.findMany({ include: { entries: true } });
  for (const t of all) {
    const net = t.entries.reduce((a, e) => a + e.amountMinorUnits, 0n);
    assert.equal(net, 0n, `ledger txn ${t.id} (${t.type}) nets ${net}`);
  }
  ok('P18 closed book: every LedgerTransaction still nets zero');
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.pass).length;
for (const r of results) {
  console.log(`${r.pass ? 'PASS ' : 'FAIL '} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log('================================================================');
console.log(`${passed}/${results.length} probes passed`);
console.log('cleanup: all probe rows removed');
await prisma.$disconnect();
redis.disconnect?.();
socketServer.close();
process.exit(passed === results.length ? 0 : 1);
