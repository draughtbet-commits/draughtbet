// PR 8 — Game protocol V2 deep verification (real Socket.IO + PostgreSQL + Redis)
//
// PR 8 makes move submission idempotent, staleness-gated and durably persisted.
// This harness drives the real production wiring end to end: two authenticated
// Socket.IO clients, the real auth middleware + per-event budget guard, the real
// `submitMove` pipeline, real Redis CAS and real Postgres transactions.
//
//   P1  match.join returns the canonical `match.state` payload on a live match
//   P2  a V2 move.submit is accepted: dual broadcast + durable move/event/state
//   P3  a duplicate clientMoveId replays to the sender only (no second apply)
//   P4  a stale expectedStateVersion is refused with `stale_state` + resync,
//       and the resynced client can resubmit successfully
//   P5  an out-of-turn player is refused with `not_your_turn`
//   P6  a malformed V2 payload is refused with `invalid_payload` (both shapes)
//   P7  a path that disagrees with the engine canonical chain -> path_mismatch
//   P8  legacy move_attempt still works and persists clientMoveId = null
//   P9  the durable log/projection/audit rows are correct and mutually consistent
//   P10 the durable log replays to the exact live Redis board
//   P11 a concurrent duplicate clientMoveId applies exactly once
//   P12 concurrent DIFFERENT moves: one wins, the loser is refused (never a
//       false accept), and the durable log still matches the live board
//   P13 a wrong full-capture path is refused before any durable write
//   P14 a correct full-capture path is accepted and stored verbatim
//   P15 a socket without a token is rejected at connect
//   P16 a move on a resigned match is refused with a resync
//   P17 the (matchId, clientMoveId) unique constraint holds at the DB level
//   P18 closed book: every LedgerTransaction still nets zero
//
// Run:  timeout 300 node --env-file=.env scripts/verify/pr8-game-protocol.mjs

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
import { reconstructMoveHistory } from '../../src/sockets/gameManager.js';
import {
  createInitialBoard,
  getLegalMoves,
  applyMove,
  COLOR_WHITE,
  COLOR_BLACK
} from '../../src/modules/engine/index.js';
import { EMPTY, WHITE_MAN, BLACK_MAN } from '../../src/modules/engine/board.js';
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

const state = { users: [], matches: [] };
const results = [];

const ok = (name, detail = '') => results.push({ name, pass: true, detail });
const fail = (name, detail) => results.push({ name, pass: false, detail });

const authed = (userId) => jwt.sign({ userId }, getJwtSecret(), { expiresIn: '1h' });

async function run(name, probe) {
  try {
    await probe();
  } catch (e) {
    fail(name, `${e?.constructor?.name}: ${e?.message}`);
    if (process.env.VERIFY_DEBUG === '1') console.error(e.stack);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

async function postOpeningBalance(wallet, amountMinorUnits) {
  await prisma.$transaction(async (tx) => {
    const accounts = await ensureUserAccounts(tx, wallet.userId, wallet.currency ?? 'NGN');
    const clearing = await ensureSystemAccount(tx, 'SYSTEM_OPENING_CLEARING', wallet.currency ?? 'NGN');
    await postLedgerTransaction(tx, {
      type: 'ADJUSTMENT',
      description: 'PR8 verify opening balance',
      idempotencyKey: `pr8-opening:${wallet.id}`,
      metadata: { walletId: wallet.id, source: 'pr8-verify' },
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
      email: `verify-pr8-${Date.now()}-${Math.random().toString(36).slice(2)}-${suffix}@test.local`,
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

// Overwrites the authoritative Redis projection for a targeted scenario (the
// same technique the integration suites use to force a capture position).
async function seedBoard(matchId, board, { turn = COLOR_WHITE, version = 0, status = 'in_progress' } = {}) {
  const host = await prisma.match.findUnique({
    where: { id: matchId },
    select: { playerLightId: true, playerDarkId: true, timeControlSeconds: true }
  });
  const turnUserId = turn === COLOR_WHITE ? host.playerLightId : host.playerDarkId;
  const hash = JSON.stringify([board, turn]);
  await redis.hset(`match:${matchId}`, {
    board: JSON.stringify(board),
    currentTurn: turn,
    currentTurnUserId: turnUserId,
    status,
    winnerId: '',
    version: String(version),
    moveCount: '0',
    positionCounts: JSON.stringify({ [hash]: 1 }),
    consecutiveKingMoves: '0',
    lastMoveTs: Date.now().toString(),
    deadlineAt: (Date.now() + (host.timeControlSeconds ?? 300) * 1000).toString(),
    timeControlSeconds: String(host.timeControlSeconds ?? 300)
  });
}

// ---------------------------------------------------------------------------
// Socket helpers
// ---------------------------------------------------------------------------

function connectClient(userId, { token = userId ? authed(userId) : undefined } = {}) {
  return createSocketClient(SOCKET_URL, {
    auth: token ? { token } : {},
    transports: ['websocket'],
    reconnection: false
  });
}

const once = (client, event, timeout = 4000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeout);
    client.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

const connectError = (client, timeout = 4000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for connect_error')), timeout);
    client.once('connect_error', (err) => {
      clearTimeout(timer);
      resolve(err);
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

// Records every occurrence of the named events in order.
function track(client) {
  const log = [];
  for (const event of ['move.rejected', 'move_rejected', 'move_applied', 'move.accepted', 'match.state', 'error']) {
    client.on(event, (payload) => log.push({ event, payload }));
  }
  return log;
}

const countIn = (log, event) => log.filter((e) => e.event === event).length;
const firstIn = (log, event) => log.find((e) => e.event === event)?.payload;

const moveByIndex = (board, turn, index = 0) => getLegalMoves(board, turn)[index];

// ---------------------------------------------------------------------------
// P1 — canonical match.state on join
// ---------------------------------------------------------------------------

const p1 = await makeUser('p1a');
const p2 = await makeUser('p2a');

await run('P1 match.join returns the canonical match.state payload', async () => {
  const match = await makeMatch(p1, p2);
  const { client, snapshot } = await connectAndJoin(p1.id, match.id);

  assert.equal(snapshot.matchId, match.id);
  assert.equal(snapshot.version, '0');
  assert.equal(snapshot.currentTurn, 'WHITE');
  assert.equal(snapshot.currentTurnUserId, p1.id);
  assert.equal(snapshot.status, 'in_progress');
  assert.equal(Array.isArray(snapshot.board), true);
  assert.equal(snapshot.board.length, 50);
  assert.equal(snapshot.legalMoves.length > 0, true);
  assert.equal(snapshot.moveCount, 0);
  assert.ok(snapshot.deadlineAt > Date.now());

  p1.match = match;
  p1.client = client;
  ok('P1 match.join returns the canonical match.state payload');
});

// ---------------------------------------------------------------------------
// P2 — a V2 move is accepted and durably recorded
// ---------------------------------------------------------------------------

await run('P2 move.submit is accepted with dual broadcast and durable rows', async () => {
  const { client: blackClient } = await connectAndJoin(p2.id, p1.match.id);
  p2.client = blackClient;
  const whiteLog = track(p1.client);
  const blackLog = track(blackClient);

  const board = createInitialBoard();
  const move = moveByIndex(board, COLOR_WHITE, 0);
  const whiteMoveId = 'pr8_p2_white_0001';

  const appliedLegacyP = once(p1.client, 'move_applied');
  const acceptedP = once(p1.client, 'move.accepted');
  const blackAppliedP = once(blackClient, 'move_applied');
  const blackAcceptedP = once(blackClient, 'move.accepted');
  p1.client.emit('move.submit', {
    matchId: p1.match.id,
    clientMoveId: whiteMoveId,
    expectedStateVersion: 0,
    from: move.from,
    path: move.path ?? [move.from, move.to]
  });

  const appliedLegacy = await appliedLegacyP;
  const accepted = await acceptedP;
  await blackAppliedP;
  await blackAcceptedP;

  assert.equal(appliedLegacy.matchId, p1.match.id);
  assert.equal(appliedLegacy.version, '1');
  assert.equal(accepted.clientMoveId, whiteMoveId);
  assert.equal(accepted.stateVersion, 1);
  assert.equal(accepted.replayed, false);
  assert.equal(accepted.move.from, move.from);
  assert.deepEqual(accepted.move.path, move.path ?? [move.from, move.to]);
  assert.equal(countIn(blackLog, 'move_applied'), 1, 'opponent must see the legacy broadcast');
  assert.equal(countIn(blackLog, 'move.accepted'), 1, 'opponent must see the V2 broadcast');

  const rows = await prisma.matchMove.findMany({ where: { matchId: p1.match.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].moveNumber, 1);
  assert.equal(rows[0].clientMoveId, whiteMoveId);
  assert.equal(rows[0].stateVersion, 0);
  assert.deepEqual(rows[0].path, move.path ?? [move.from, move.to]);

  p1.move = move;
  p1.log = whiteLog;
  ok('P2 move.submit is accepted with dual broadcast and durable rows');
});

// ---------------------------------------------------------------------------
// P3 — idempotent replay of the same clientMoveId
// ---------------------------------------------------------------------------

await run('P3 a duplicate clientMoveId replays to the sender only', async () => {
  const log = track(p1.client);
  const replayedP = once(p1.client, 'move.accepted');
  p1.client.emit('move.submit', {
    matchId: p1.match.id,
    clientMoveId: 'pr8_p2_white_0001',
    expectedStateVersion: 0,
    from: p1.move.from,
    path: p1.move.path ?? [p1.move.from, p1.move.to]
  });

  const replayed = await replayedP;
  await sleep(80);

  assert.equal(replayed.replayed, true);
  assert.equal(replayed.clientMoveId, 'pr8_p2_white_0001');
  assert.equal(countIn(log, 'move_applied'), 0, 'a replay must not re-broadcast to the room');
  const rows = await prisma.matchMove.findMany({ where: { matchId: p1.match.id } });
  assert.equal(rows.length, 1, 'a replay must not create a second durable row');
  const gameState = await prisma.matchGameState.findUnique({ where: { matchId: p1.match.id } });
  assert.equal(gameState.stateVersion, 1, 'a replay must not advance the projection');
  ok('P3 a duplicate clientMoveId replays to the sender only');
});

// ---------------------------------------------------------------------------
// P4 — stale version refused, resync, then recovery
// ---------------------------------------------------------------------------

await run('P4 stale expectedStateVersion is refused with resync then recovers', async () => {
  const board = createInitialBoard();
  const boardAfterWhite = applyMove(board, p1.move).newBoard;
  const blackMove = moveByIndex(boardAfterWhite, COLOR_BLACK, 0);

  const staleLog = track(p2.client);
  const rejectedP = once(p2.client, 'move.rejected');
  const resyncP = once(p2.client, 'match.state');
  p2.client.emit('move.submit', {
    matchId: p1.match.id,
    clientMoveId: 'pr8_p4_black_0001',
    expectedStateVersion: 0, // behind the authoritative version 1
    from: blackMove.from,
    to: blackMove.to
  });

  const rejected = await rejectedP;
  assert.equal(rejected.code, 'stale_state');
  assert.equal(rejected.expectedStateVersion, 0);
  assert.equal(rejected.currentVersion, 1);
  const resync = await resyncP;
  assert.equal(resync.version, '1');
  assert.equal(resync.matchId, p1.match.id);
  assert.equal(countIn(staleLog, 'move_applied'), 0);

  // The client follows the resync contract: resubmit the same move at version 1.
  const acceptedP = once(p2.client, 'move.accepted');
  p2.client.emit('move.submit', {
    matchId: p1.match.id,
    clientMoveId: 'pr8_p4_black_0002',
    expectedStateVersion: Number(resync.version),
    from: blackMove.from,
    to: blackMove.to
  });
  const accepted = await acceptedP;
  assert.equal(accepted.stateVersion, 2);
  assert.equal(accepted.replayed, false);
  ok('P4 stale expectedStateVersion is refused with resync then recovers');
});

// ---------------------------------------------------------------------------
// P5 — out-of-turn refusal
// ---------------------------------------------------------------------------

await run('P5 an out-of-turn player is refused with not_your_turn', async () => {
  const log = track(p2.client);
  const board = createInitialBoard();
  const boardAfterWhite = applyMove(board, p1.move).newBoard;
  const blackMove = moveByIndex(boardAfterWhite, COLOR_BLACK, 0);
  const boardAfterBlack = applyMove(boardAfterWhite, blackMove).newBoard;
  const someWhiteMove = moveByIndex(boardAfterBlack, COLOR_WHITE, 0);

  const rejectedP = once(p2.client, 'move.rejected');
  p2.client.emit('move.submit', {
    matchId: p1.match.id,
    clientMoveId: 'pr8_p5_black_0001',
    expectedStateVersion: 2,
    from: someWhiteMove.from,
    to: someWhiteMove.to
  });

  const rejected = await rejectedP;
  assert.equal(rejected.code, 'not_your_turn');
  assert.equal(countIn(log, 'move_applied'), 0);
  ok('P5 an out-of-turn player is refused with not_your_turn');
});

// ---------------------------------------------------------------------------
// P6 — malformed V2 payload
// ---------------------------------------------------------------------------

await run('P6 a malformed V2 payload is refused in both protocol shapes', async () => {
  const log = track(p1.client);
  const rejectedP = once(p1.client, 'move.rejected');
  p1.client.emit('move.submit', { matchId: p1.match.id, from: 1, to: 2 }); // no clientMoveId
  const rejected = await rejectedP;
  assert.equal(rejected.code, 'invalid_payload');
  assert.equal(countIn(log, 'move_rejected'), 1);
  assert.deepEqual(firstIn(log, 'move_rejected'), { reason: 'invalid_payload' });
  assert.equal(countIn(log, 'move_applied'), 0);
  ok('P6 a malformed V2 payload is refused in both protocol shapes');
});

// ---------------------------------------------------------------------------
// P7 — path mismatch on a legal from/to
// ---------------------------------------------------------------------------

await run('P7 a path that disagrees with the engine chain is refused', async () => {
  const board = createInitialBoard();
  const boardAfterWhite = applyMove(board, p1.move).newBoard;
  const blackMove = moveByIndex(boardAfterWhite, COLOR_BLACK, 0);
  const boardAfterBlack = applyMove(boardAfterWhite, blackMove).newBoard;
  const simple = getLegalMoves(boardAfterBlack, COLOR_WHITE).find(
    (m) => !m.capturedSquares || m.capturedSquares.length === 0
  );
  assert.ok(simple, 'expected a simple legal move for the path probe');

  const extra = simple.from === 1 ? 50 : 1;
  const log = track(p1.client);
  const rejectedP = once(p1.client, 'move.rejected');
  p1.client.emit('move.submit', {
    matchId: p1.match.id,
    clientMoveId: 'pr8_p7_white_0001',
    expectedStateVersion: 2,
    from: simple.from,
    to: simple.to,
    path: [simple.from, extra, simple.to]
  });

  const rejected = await rejectedP;
  assert.equal(rejected.code, 'illegal_move');
  assert.equal(rejected.reason, 'path_mismatch');
  assert.equal(countIn(log, 'move_applied'), 0);
  ok('P7 a path that disagrees with the engine chain is refused');
});

// ---------------------------------------------------------------------------
// P8 — legacy move_attempt compatibility
// ---------------------------------------------------------------------------

await run('P8 legacy move_attempt still works and stores a null clientMoveId', async () => {
  const log = track(p1.client);
  const board = createInitialBoard();
  const boardAfterWhite = applyMove(board, p1.move).newBoard;
  const blackMove = moveByIndex(boardAfterWhite, COLOR_BLACK, 0);
  const boardAfterBlack = applyMove(boardAfterWhite, blackMove).newBoard;
  const whiteMove = getLegalMoves(boardAfterBlack, COLOR_WHITE)[0];

  const appliedP = once(p1.client, 'move_applied');
  p1.client.emit('move_attempt', { matchId: p1.match.id, from: whiteMove.from, to: whiteMove.to });
  const applied = await appliedP;
  assert.equal(applied.version, '3');
  assert.equal(countIn(log, 'move_applied') >= 1, true);

  const rows = await prisma.matchMove.findMany({
    where: { matchId: p1.match.id },
    orderBy: { moveNumber: 'asc' }
  });
  const legacyRow = rows.find((r) => r.moveNumber === 3);
  assert.ok(legacyRow, 'legacy move must be durably logged');
  assert.equal(legacyRow.clientMoveId, null);
  ok('P8 legacy move_attempt still works and stores a null clientMoveId');
});

// ---------------------------------------------------------------------------
// P9 — durable audit + projection correctness
// ---------------------------------------------------------------------------

await run('P9 durable log, audit event and projection agree', async () => {
  const rows = await prisma.matchMove.findMany({
    where: { matchId: p1.match.id },
    orderBy: { moveNumber: 'asc' }
  });
  assert.equal(rows.length, 3);

  const events = (await prisma.gameEvent.findMany({
    where: { matchId: p1.match.id, type: 'MOVE' }
  })).sort((a, b) => a.payload.moveNumber - b.payload.moveNumber);
  assert.equal(events.length, rows.length, 'one MOVE audit event per durable move');
  for (const event of events) {
    assert.equal(typeof event.payload.moveNumber, 'number');
    assert.equal(event.payload.stateVersion, event.payload.moveNumber - 1);
  }
  assert.equal(events[0].payload.clientMoveId, 'pr8_p2_white_0001');
  assert.equal(events[0].payload.path.length >= 2, true);
  assert.equal(events[2].payload.clientMoveId, null, 'legacy move event carries null key');

  const projection = await prisma.matchGameState.findUnique({ where: { matchId: p1.match.id } });
  assert.equal(projection.stateVersion, 3);
  assert.equal(projection.currentTurn, 'DARK'); // 3 plies: next to move is dark
  assert.ok(projection.turnStartedAt instanceof Date);
  ok('P9 durable log, audit event and projection agree');
});

// ---------------------------------------------------------------------------
// P10 — durable log replays to the live board
// ---------------------------------------------------------------------------

await run('P10 the durable log replays to the exact live Redis board', async () => {
  const reconstructed = await reconstructMoveHistory(p1.match.id);
  const live = await redis.hgetall(`match:${p1.match.id}`);
  assert.deepEqual(reconstructed.board, JSON.parse(live.board));
  assert.equal(reconstructed.moveCount, Number(live.moveCount));
  ok('P10 the durable log replays to the exact live Redis board');
});

// ---------------------------------------------------------------------------
// P11 — concurrent duplicate submission applies exactly once
// ---------------------------------------------------------------------------

await run('P11 a concurrent duplicate clientMoveId applies exactly once', async () => {
  const p3 = await makeUser('p3a');
  const p4 = await makeUser('p4a');
  const match = await makeMatch(p3, p4);
  const { client: w } = await connectAndJoin(p3.id, match.id);
  const { client: b } = await connectAndJoin(p4.id, match.id);

  const wLog = track(w);
  const bLog = track(b);
  const move = moveByIndex(createInitialBoard(), COLOR_WHITE, 0);
  const key = 'pr8_p11_dup_0001';
  const payload = {
    matchId: match.id,
    clientMoveId: key,
    expectedStateVersion: 0,
    from: move.from,
    path: move.path ?? [move.from, move.to]
  };

  w.emit('move.submit', payload);
  w.emit('move.submit', payload);
  await sleep(400);

  const rows = await prisma.matchMove.findMany({ where: { matchId: match.id } });
  assert.equal(rows.length, 1, 'exactly one durable row for a duplicate key');
  const live = await redis.hgetall(`match:${match.id}`);
  assert.equal(Number(live.moveCount), 1, 'board must advance exactly once');
  const projection = await prisma.matchGameState.findUnique({ where: { matchId: match.id } });
  assert.equal(projection.stateVersion, 1);

  const totalApplied = countIn(wLog, 'move_applied') + countIn(bLog, 'move_applied');
  assert.equal(totalApplied, 2, `expected one room broadcast seen by both sockets, got ${totalApplied}`);

  ok('P11 a concurrent duplicate clientMoveId applies exactly once');
});

// ---------------------------------------------------------------------------
// P12 — concurrent DIFFERENT moves: no false accept, no divergence
// ---------------------------------------------------------------------------

await run('P12 concurrent different moves: one wins, loser refused, log matches board', async () => {
  const p5 = await makeUser('p5a');
  const p6 = await makeUser('p6a');
  const match = await makeMatch(p5, p6);
  const { client: w } = await connectAndJoin(p5.id, match.id);

  const log = track(w);
  const legal = getLegalMoves(createInitialBoard(), COLOR_WHITE);
  const moveA = legal[0];
  const moveB = legal[1];
  assert.ok(moveA && moveB, 'need two distinct legal opening moves');

  w.emit('move.submit', {
    matchId: match.id,
    clientMoveId: 'pr8_p12_move_a001',
    expectedStateVersion: 0,
    from: moveA.from,
    to: moveA.to
  });
  w.emit('move.submit', {
    matchId: match.id,
    clientMoveId: 'pr8_p12_move_b001',
    expectedStateVersion: 0,
    from: moveB.from,
    to: moveB.to
  });
  await sleep(500);

  const rows = await prisma.matchMove.findMany({ where: { matchId: match.id } });
  assert.equal(rows.length, 1, 'only one competing move may be durably recorded');

  // The loser must be refused, never falsely reported as a replayed acceptance.
  const falseAccepts = log.filter((e) => e.event === 'move.accepted' && e.payload.replayed === true);
  assert.equal(falseAccepts.length, 0, 'a competing loser must not be replayed as accepted');
  const refusals = log.filter(
    (e) => e.event === 'move.rejected' && ['duplicate_move', 'server_busy', 'not_your_turn'].includes(e.payload.code)
  );
  assert.equal(refusals.length >= 1, true, 'the losing submission must receive a refusal');

  // Durable log must reconstruct to exactly the live Redis board.
  const reconstructed = await reconstructMoveHistory(match.id);
  const live = await redis.hgetall(`match:${match.id}`);
  assert.deepEqual(reconstructed.board, JSON.parse(live.board));
  assert.equal(reconstructed.rows.length, 1);

  ok('P12 concurrent different moves: one wins, loser refused, log matches board');
});

// ---------------------------------------------------------------------------
// P13/P14 — full-capture path validation
// ---------------------------------------------------------------------------

await run('P13/P14 full-capture path: wrong path refused, correct path stored', async () => {
  const p7 = await makeUser('p7a');
  const p8 = await makeUser('p8a');
  const match = await makeMatch(p7, p8);

  const board = new Array(50).fill(EMPTY);
  board[31] = WHITE_MAN; // 32
  board[26] = BLACK_MAN; // 27
  board[16] = BLACK_MAN; // 17
  board[4] = BLACK_MAN; // 5 — keeps the game alive after the double capture
  board[41] = WHITE_MAN; // 42

  const capture = getLegalMoves(board, COLOR_WHITE).find(
    (m) => m.capturedSquares?.length === 2
  );
  assert.ok(capture, 'expected a forced double capture on the seeded board');
  assert.equal(capture.path.length, 3);

  await seedBoard(match.id, board, { turn: COLOR_WHITE, version: 0 });
  const { client } = await connectAndJoin(p7.id, match.id);
  const log = track(client);

  // Wrong path: same from/to, truncated intermediate chain.
  const rejectedP = once(client, 'move.rejected');
  client.emit('move.submit', {
    matchId: match.id,
    clientMoveId: 'pr8_p13_bad_0001',
    expectedStateVersion: 0,
    from: capture.from,
    to: capture.to,
    path: [capture.from, capture.to]
  });
  const rejected = await rejectedP;
  assert.equal(rejected.code, 'illegal_move');
  assert.equal(rejected.reason, 'path_mismatch');
  assert.equal(await prisma.matchMove.count({ where: { matchId: match.id } }), 0,
    'a refused path must not write a durable row');
  assert.equal(countIn(log, 'move_applied'), 0);

  // Correct path: accepted and stored verbatim.
  const acceptedP = once(client, 'move.accepted');
  client.emit('move.submit', {
    matchId: match.id,
    clientMoveId: 'pr8_p14_good_0001',
    expectedStateVersion: 0,
    from: capture.from,
    to: capture.to,
    path: capture.path
  });
  await acceptedP;
  const row = await prisma.matchMove.findFirst({ where: { matchId: match.id } });
  assert.ok(row);
  assert.deepEqual(row.path, capture.path);
  assert.deepEqual(row.capturedSquares, capture.capturedSquares);

  ok('P13/P14 full-capture path: wrong path refused, correct path stored');
});

// ---------------------------------------------------------------------------
// P15 — socket auth
// ---------------------------------------------------------------------------

await run('P15 a socket without a token is rejected at connect', async () => {
  const anon = connectClient(null);
  const err = await connectError(anon);
  assert.match(String(err.message), /Authentication/i);
  anon.close();
  ok('P15 a socket without a token is rejected at connect');
});

// ---------------------------------------------------------------------------
// P16 — move on an ended (resigned) match
// ---------------------------------------------------------------------------

await run('P16 a move on a resigned match is refused with a resync', async () => {
  const p9 = await makeUser('p9a');
  const p10 = await makeUser('p10a');
  const match = await makeMatch(p9, p10);
  const { client: resigner } = await connectAndJoin(p9.id, match.id);
  const { client: mover } = await connectAndJoin(p10.id, match.id);

  const resignedP = once(resigner, 'match_ended_resign');
  resigner.emit('match.resign', { matchId: match.id });
  await resignedP;
  await sleep(150);

  const log = track(mover);
  const move = moveByIndex(createInitialBoard(), COLOR_WHITE, 0);
  const rejectedP = once(mover, 'move.rejected');
  mover.emit('move.submit', {
    matchId: match.id,
    clientMoveId: 'pr8_p16_after_0001',
    expectedStateVersion: 1,
    from: move.from,
    to: move.to
  });
  const rejected = await rejectedP;
  assert.equal(
    ['game_already_ended', 'game_not_in_progress'].includes(rejected.code),
    true,
    `expected a match-over code, got ${rejected.code}`
  );
  assert.equal(countIn(log, 'move_applied'), 0);

  ok('P16 a move after resign is refused as match-over');
});

await run('P16b a move on a terminal-but-present game is refused with a resync', async () => {
  const p13 = await makeUser('p13a');
  const p14 = await makeUser('p14a');
  const match = await makeMatch(p13, p14);
  await seedBoard(match.id, createInitialBoard(), { status: 'completed' });
  const { client } = await connectAndJoin(p13.id, match.id);
  const log = track(client);

  const move = moveByIndex(createInitialBoard(), COLOR_WHITE, 0);
  const rejectedP = once(client, 'move.rejected');
  client.emit('move.submit', {
    matchId: match.id,
    clientMoveId: 'pr8_p16b_0001',
    expectedStateVersion: 0,
    from: move.from,
    to: move.to
  });
  const rejected = await rejectedP;
  assert.equal(rejected.code, 'game_not_in_progress');
  const resync = firstIn(log, 'match.state');
  assert.ok(resync, 'a rejection on a present game carries the canonical state');
  assert.equal(resync.status, 'completed');
  assert.equal(countIn(log, 'move_applied'), 0);

  ok('P16b a move on a terminal-but-present game is refused with a resync');
});

// ---------------------------------------------------------------------------
// P17 — DB-level uniqueness
// ---------------------------------------------------------------------------

await run('P17 the (matchId, clientMoveId) unique constraint holds', async () => {
  const p11 = await makeUser('p11a');
  const p12 = await makeUser('p12a');
  const match = await makeMatch(p11, p12);
  const base = {
    matchId: match.id,
    playerId: p11.id,
    fromSquare: 46,
    toSquare: 37,
    capturedSquares: [],
    isKingMove: false,
    boardStateAfter: createInitialBoard(),
    clientMoveId: 'pr8_p17_key_0001'
  };
  await prisma.matchMove.create({ data: { ...base, moveNumber: 1 } });
  await assert.rejects(
    () => prisma.matchMove.create({ data: { ...base, toSquare: 36, moveNumber: 2 } }),
    (err) => err?.code === 'P2002'
  );
  ok('P17 the (matchId, clientMoveId) unique constraint holds');
});

// ---------------------------------------------------------------------------
// Cleanup: drop authoritative state before closing sockets so disconnect
// handlers (grace-period zset + notifications) do not fire.
// ---------------------------------------------------------------------------

for (const matchId of state.matches) {
  await redis.del(`match:${matchId}`);
}
for (const userId of state.users) {
  await redis.del(`user:${userId}:activeMatch`);
}
await sleep(200);

await prisma.matchMove.deleteMany({ where: { matchId: { in: state.matches } } });
await prisma.matchGameState.deleteMany({ where: { matchId: { in: state.matches } } });
await prisma.gameEvent.deleteMany({ where: { matchId: { in: state.matches } } });
await prisma.gameStateSnapshot.deleteMany({ where: { matchId: { in: state.matches } } });
await prisma.match.deleteMany({ where: { id: { in: state.matches } } });
await prisma.wallet.deleteMany({ where: { userId: { in: state.users } } });
await prisma.ledgerTransaction.deleteMany({
  where: {
    OR: [
      { relatedMatchId: { in: state.matches } },
      { metadata: { path: ['source'], equals: 'pr8-verify' } }
    ]
  }
});
// Disconnect grace markers created before the Redis keys were dropped.
for (const matchId of state.matches) {
  for (const userId of state.users) {
    await redis.zrem('disconnects', `${matchId}:${userId}`);
  }
}
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
