// Deep verification for PR 5 (Settlement V2).
//
// Exercises the real modules and the real Postgres + Redis dev stack, then
// asserts the financial invariants directly with SQL-level sums. Run from
// backend/ against a reachable dev DB + Redis:
//
//   DATABASE_URL=postgresql://draughts_arena:change_me_draughts_arena@127.0.0.1:5432/draughts_arena?schema=public \
//   REDIS_URL=redis://:change_me_draughts_redis@127.0.0.1:6379 \
//   node scripts/verify/pr5-settlement.mjs
//
// All probe rows are cleaned up at the end (including V2 ledger rows, which
// must go before users because LedgerEntry.account is onDelete Restrict).
//
// Invariants checked:
//   P1  win settlement: claim, money math, mirror, receipts, terminal record
//   P2  draw settlement: full refunds both ways, record netPayout = pot
//   P3  replay of a settled match: no new money, no new rows, consistent payload
//   P4  concurrent win/win: exactly one claim, one posting, one credit
//   P5  win vs draw race: single settlement posting consistent with the kind
//   P6  rejectable input writes nothing at all (atomicity before the claim)
//   P7  non-settleable matches throw and write nothing
//   P8  socket path end-to-end: Redis cleanup, exactly-once notifications
//   P9  restart-replay: gate-fired cleanup credits nothing and does not duplicate
//   P10 closed-book: every ledger transaction is zero-sum and reconciles to the
//       signed legacy WalletTransaction deltas for each player

import assert from 'node:assert/strict';
import http from 'node:http';
import prisma from '../../src/utils/db.js';
import redis from '../../src/utils/redis.js';
import { debitStakes } from '../../src/services/matchService.js';
import { finalizeMatchActivation } from '../../src/services/gameActivationService.js';
import { settleGame, settleGameWithRetry } from '../../src/sockets/settlement.js';
import { SettlementService } from '../../src/modules/settlement/service.js';
import { initSocketServer } from '../../src/sockets/index.js';
import { SYSTEM_ACCOUNT_ID, getAccountBalance } from '../../src/services/ledgerService.js';

// The socket path emits match_ended / wallet_updated and reads online presence
// through Socket.IO; without a server, getIO() is undefined and every emit
// throws before the notification rows are written. Give the harness a real
// (non-listen-required) Socket.IO server so the whole cleanup path runs.
const httpServer = http.createServer();
httpServer.listen(0);
initSocketServer(httpServer);

const STAKE = 50_000n;
const COMMISSION_PERCENT = 10;
const PAYOUT = 90_000n;  // pot - 10% commission
const COMMISSION = 10_000n;
const POT = 100_000n;

const state = { users: [], matches: [] };
const results = [];

const ok = (name, detail = '') => results.push({ name, pass: true, detail });
const fail = (name, detail) => results.push({ name, pass: false, detail });

let u1;
let u2;

async function makeUser(suffix) {
  const user = await prisma.user.create({
    data: {
      email: `verify-pr5-${Date.now()}-${Math.random().toString(36).slice(2)}-${suffix}@test.local`,
      passwordHash: 'x',
      kycStatus: 'VERIFIED',
      countryCode: 'NG',
      eligibility: {
        create: { countryCode: 'NG', countryAllowed: true, ageVerified: true }
      }
    }
  });
  await prisma.wallet.create({ data: { userId: user.id, balanceMinorUnits: 100_000n } });
  state.users.push(user.id);
  return user;
}

async function freshPair() {
  u1 = await makeUser('a');
  u2 = await makeUser('b');
  return [u1, u2];
}

async function fundMatch() {
  await prisma.platformSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', commissionPercent: COMMISSION_PERCENT },
    update: { commissionPercent: COMMISSION_PERCENT }
  });
  const match = await debitStakes(u1.id, u2.id, STAKE, 'AMATEUR');
  state.matches.push(match.id);
  const outbox = await prisma.gameOutbox.findUnique({
    where: { matchId: match.id },
    select: { id: true }
  });
  await finalizeMatchActivation(outbox.id);
  return match;
}

async function seedRedisLoop(matchId) {
  await redis.set(`match:${matchId}`, 'live');
  await redis.set(`user:${u1.id}:activeMatch`, matchId);
  await redis.set(`user:${u2.id}:activeMatch`, matchId);
}

async function ledgerRows(matchId) {
  return prisma.ledgerTransaction.findMany({
    where: { relatedMatchId: matchId },
    include: { entries: true }
  });
}

async function accountId(userId, type) {
  const a = await prisma.ledgerAccount.findUnique({
    where: { userId_type_currency: { userId, type, currency: 'NGN' } }
  });
  return a.id;
}

async function walletFor(userId) {
  return prisma.wallet.findUnique({ where: { userId } });
}

function entrySumOf(tx, accountId) {
  return tx.entries
    .filter((e) => e.accountId === accountId)
    .reduce((acc, e) => acc + e.amountMinorUnits, 0n);
}

async function zeroSumPerTx(matchId) {
  const txs = await ledgerRows(matchId);
  const bad = [];
  for (const t of txs) {
    const sum = t.entries.reduce((acc, e) => acc + e.amountMinorUnits, 0n);
    if (sum !== 0n) bad.push({ id: t.id, type: t.type, sum: sum.toString() });
  }
  return { txs, bad };
}

async function run(name, probe) {
  try {
    await probe();
  } catch (e) {
    fail(name, `${e?.constructor?.name}: ${e?.message}`);
    if (process.env.VERIFY_DEBUG === '1') console.error(e.stack);
  }
}

// ---------------------------------------------------------------------------

await run('P1 win settlement: claim, math, mirror, receipts, record', async () => {
  await freshPair();
  const m = await fundMatch();

  const preWinner = await walletFor(u1.id);
  const preLoser = await walletFor(u2.id);

  const res = await SettlementService.settleMatch(m.id, {
    result: 'WIN', winnerId: u1.id, loserId: u2.id, endReason: 'RESIGN'
  });
  assert.equal(res.claimed, true);
  assert.equal(res.replayed, false);
  assert.equal(res.payout, PAYOUT);
  assert.equal(res.commission, COMMISSION);

  const match = await prisma.match.findUnique({ where: { id: m.id } });
  assert.equal(match.status, 'SETTLED');
  assert.equal(match.winnerId, u1.id);
  assert.equal(match.endReason, 'RESIGN');
  assert.ok(match.endedAt);

  // Money: winner wallet 100k -50k +90k = 140k; loser stays 50k.
  const postWinner = await walletFor(u1.id);
  const postLoser = await walletFor(u2.id);
  assert.equal(postWinner.balanceMinorUnits - preWinner.balanceMinorUnits, PAYOUT);
  assert.equal(postLoser.balanceMinorUnits, preLoser.balanceMinorUnits);

  // Mirror: exactly one PAYOUT, on the winner's wallet only.
  const payouts = await prisma.walletTransaction.findMany({
    where: { relatedMatchId: m.id, type: 'PAYOUT' }
  });
  assert.equal(payouts.length, 1);
  assert.equal(payouts[0].amountMinorUnits, PAYOUT);

  // Ledger: SETTLEMENT_PAYOUT entries break down +90k winner avail, -50k both
  // locks, +10k platform; idempotency key present.
  const { txs, bad } = await zeroSumPerTx(m.id);
  assert.deepEqual(bad, []);
  const payoutTx = txs.find((t) => t.type === 'SETTLEMENT_PAYOUT');
  assert.ok(payoutTx);
  assert.equal(payoutTx.idempotencyKey, `MATCH_SETTLEMENT:${m.id}`);
  const revId = SYSTEM_ACCOUNT_ID('PLATFORM_REVENUE', 'NGN');
  assert.equal(entrySumOf(payoutTx, await accountId(u1.id, 'PLAYER_AVAILABLE')), PAYOUT);
  assert.equal(entrySumOf(payoutTx, await accountId(u1.id, 'PLAYER_LOCKED')), -STAKE);
  assert.equal(entrySumOf(payoutTx, await accountId(u2.id, 'PLAYER_LOCKED')), -STAKE);
  assert.equal(entrySumOf(payoutTx, revId), COMMISSION);

  // Reservation lifecycle completes: both rows SETTLED, money moved via
  // settlement, not released.
  const reservations = await prisma.stakeReservation.findMany({ where: { matchId: m.id } });
  assert.equal(reservations.length, 2);
  assert.ok(reservations.every((r) => r.status === 'SETTLED'));

  // Terminal record + receipts.
  const s = await prisma.matchSettlement.findUnique({ where: { matchId: m.id } });
  assert.equal(s.status, 'SETTLED');
  assert.equal(s.winnerId, u1.id);
  assert.equal(s.feeSnapshotBps, COMMISSION_PERCENT);
  assert.equal(s.netPayoutMinorUnits, PAYOUT);
  const receipts = await prisma.matchReceipt.findMany({ where: { matchId: m.id } });
  assert.equal(receipts.length, 2);
  const rw = receipts.find((r) => r.userId === u1.id);
  const rl = receipts.find((r) => r.userId === u2.id);
  assert.deepEqual(
    [rw.stakeMinorUnits, rw.payoutMinorUnits, rw.feeMinorUnits].map(String),
    ['50000', '90000', '10000']
  );
  assert.deepEqual(
    [rl.stakeMinorUnits, rl.payoutMinorUnits, rl.feeMinorUnits].map(String),
    ['50000', '0', '0']
  );
  // Receipt math adds up: total paid out + total fee == pot.
  const paid = receipts.reduce((a, r) => a + r.payoutMinorUnits, 0n) +
               receipts.reduce((a, r) => a + r.feeMinorUnits, 0n);
  assert.equal(paid, POT);

  ok('P1 win settlement');
});

await run('P2 draw settlement: full refund both, record netPayout = pot', async () => {
  await freshPair();
  const m = await fundMatch();

  const res = await SettlementService.settleMatch(m.id, {
    result: 'DRAW', endReason: 'DRAW_AGREEMENT'
  });
  assert.equal(res.claimed, true);
  assert.equal(res.payout, POT);          // total refunded
  assert.equal(res.commission, 0n);       // no platform cut on a draw

  const post1 = await walletFor(u1.id);
  const post2 = await walletFor(u2.id);
  assert.equal(post1.balanceMinorUnits, 100_000n);
  assert.equal(post2.balanceMinorUnits, 100_000n);

  const refunds = await prisma.walletTransaction.findMany({
    where: { relatedMatchId: m.id, type: 'REFUND' }
  });
  assert.equal(refunds.length, 2);
  assert.ok(refunds.every((r) => r.amountMinorUnits === STAKE));

  const { txs, bad } = await zeroSumPerTx(m.id);
  assert.deepEqual(bad, []);
  const payoutTx = txs.find((t) => t.type === 'SETTLEMENT_PAYOUT');
  assert.ok(payoutTx);
  // Each player -stake locked / +stake available; platform gets nothing.
  for (const u of [u1, u2]) {
    assert.equal(entrySumOf(payoutTx, await accountId(u.id, 'PLAYER_LOCKED')), -STAKE);
    assert.equal(entrySumOf(payoutTx, await accountId(u.id, 'PLAYER_AVAILABLE')), STAKE);
  }
  assert.equal(entrySumOf(payoutTx, SYSTEM_ACCOUNT_ID('PLATFORM_REVENUE', 'NGN')), 0n);

  const s = await prisma.matchSettlement.findUnique({ where: { matchId: m.id } });
  assert.equal(s.winnerId, null);
  assert.equal(s.netPayoutMinorUnits, POT);
  const receipts = await prisma.matchReceipt.findMany({ where: { matchId: m.id } });
  assert.equal(receipts.length, 2);
  assert.ok(receipts.every((r) =>
    r.stakeMinorUnits === STAKE && r.payoutMinorUnits === STAKE && r.feeMinorUnits === 0n));

  const reservations = await prisma.stakeReservation.findMany({ where: { matchId: m.id } });
  assert.ok(reservations.every((r) => r.status === 'SETTLED'));

  ok('P2 draw settlement');
});

await run('P3 replay: no new money, no new rows, consistent payload', async () => {
  await freshPair();
  const m = await fundMatch();
  await SettlementService.settleMatch(m.id, { result: 'WIN', winnerId: u1.id, endReason: 'RESIGN' });

  const before = await walletFor(u1.id);
  const txs = await ledgerRows(m.id);
  const txCount = txs.length;

  // Same result replayed.
  const replay = await SettlementService.settleMatch(m.id, { result: 'WIN', winnerId: u1.id, endReason: 'RESIGN' });
  assert.equal(replay.claimed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.payout, PAYOUT);
  assert.equal(replay.commission, COMMISSION);

  // A conflicting result also replays and never changes the committed winner.
  const conflict = await SettlementService.settleMatch(m.id, { result: 'WIN', winnerId: u2.id, endReason: 'FORFEIT' });
  assert.equal(conflict.replayed, true);
  assert.equal(conflict.settlement.winnerId, u1.id);
  assert.equal(conflict.settlement.endReason, 'RESIGN');

  const after = await walletFor(u1.id);
  assert.equal(after.balanceMinorUnits, before.balanceMinorUnits);
  assert.equal((await ledgerRows(m.id)).length, txCount);
  assert.equal(await prisma.matchSettlement.count({ where: { matchId: m.id } }), 1);
  assert.equal(
    await prisma.ledgerTransaction.count({ where: { relatedMatchId: m.id, type: 'SETTLEMENT_PAYOUT' } }),
    1
  );

  ok('P3 replay');
});

await run('P4 concurrent win/win: one claim, one posting, one credit', async () => {
  await freshPair();
  const m = await fundMatch();

  const [a, b] = await Promise.all([
    SettlementService.settleMatch(m.id, { result: 'WIN', winnerId: u1.id, endReason: 'RESIGN' }),
    SettlementService.settleMatch(m.id, { result: 'WIN', winnerId: u2.id, endReason: 'FORFEIT' })
  ]);
  assert.equal((a.claimed ? 1 : 0) + (b.claimed ? 1 : 0), 1);
  assert.equal((a.replayed ? 1 : 0) + (b.replayed ? 1 : 0), 1);

  const winnerId = a.claimed ? a.settlement.winnerId : b.settlement.winnerId;
  assert.equal(await prisma.matchSettlement.count({ where: { matchId: m.id } }), 1);
  assert.equal(
    await prisma.ledgerTransaction.count({ where: { relatedMatchId: m.id, type: 'SETTLEMENT_PAYOUT' } }),
    1
  );
  const payouts = await prisma.walletTransaction.findMany({ where: { relatedMatchId: m.id, type: 'PAYOUT' } });
  assert.equal(payouts.length, 1);
  const winnerWallet = await walletFor(winnerId);
  assert.equal(winnerWallet.balanceMinorUnits, 140_000n);
  const loserWallet = await walletFor(winnerId === u1.id ? u2.id : u1.id);
  assert.equal(loserWallet.balanceMinorUnits, 50_000n);

  const { bad } = await zeroSumPerTx(m.id);
  assert.deepEqual(bad, []);

  ok('P4 concurrent win/win');
});

await run('P5 win vs draw race: single posting consistent with the committed kind', async () => {
  await freshPair();
  const m = await fundMatch();

  await Promise.allSettled([
    SettlementService.settleMatch(m.id, { result: 'WIN', winnerId: u1.id, endReason: 'RESIGN' }),
    SettlementService.settleMatch(m.id, { result: 'DRAW', endReason: 'DRAW_AGREEMENT' })
  ]);

  const s = await prisma.matchSettlement.findUnique({ where: { matchId: m.id } });
  assert.ok(s);
  const payouts = await prisma.walletTransaction.findMany({ where: { relatedMatchId: m.id, type: 'PAYOUT' } });
  const refunds = await prisma.walletTransaction.findMany({ where: { relatedMatchId: m.id, type: 'REFUND' } });
  const { txs, bad } = await zeroSumPerTx(m.id);
  assert.deepEqual(bad, []);
  assert.equal(txs.filter((t) => t.type === 'SETTLEMENT_PAYOUT').length, 1);

  if (s.winnerId) {
    // Committed as a win: exactly one payout, platform takes its cut, no refunds.
    assert.equal(payouts.length, 1);
    assert.equal(refunds.length, 0);
    const winner = await walletFor(s.winnerId);
    assert.equal(winner.balanceMinorUnits, 140_000n);
  } else {
    // Committed as a draw: two refunds, no payout, no platform cut.
    assert.equal(refunds.length, 2);
    assert.equal(payouts.length, 0);
    assert.equal(entrySumOf(
      txs.find((t) => t.type === 'SETTLEMENT_PAYOUT'),
      SYSTEM_ACCOUNT_ID('PLATFORM_REVENUE', 'NGN')
    ), 0n);
  }

  ok('P5 win vs draw race');
});

await run('P6 rejectable input writes nothing', async () => {
  await freshPair();
  const m = await fundMatch();

  // Outsider winner.
  const stranger = await prisma.user.create({
    data: {
      email: `verify-pr5-${Date.now()}-stranger@test.local`,
      passwordHash: 'x', kycStatus: 'VERIFIED', countryCode: 'NG',
      eligibility: { create: { countryCode: 'NG', countryAllowed: true, ageVerified: true } }
    }
  });
  state.users.push(stranger.id);
  await assert.rejects(
    () => SettlementService.settleMatch(m.id, { result: 'WIN', winnerId: stranger.id, endReason: 'RESIGN' }),
    (e) => e.name === 'OutsiderSettlementError'
  );

  // Board-derived outcome with an empty move log: no durable evidence -> reject.
  // (Fresh players: a funded match occupies its pair until it settles.)
  await freshPair();
  const noEvidence = await fundMatch();
  const evLight = u1;
  const evDark = u2;
  await assert.rejects(
    () => SettlementService.settleMatch(noEvidence.id, { result: 'WIN', winnerId: evLight.id, endReason: 'NO_LEGAL_MOVES' }),
    (e) => e.name === 'InvalidSettlementError'
  );
  assert.equal((await prisma.match.findUnique({ where: { id: noEvidence.id } })).status, 'IN_PLAY');

  // Draw naming a winner.
  await freshPair();
  const drawWinner = await fundMatch();
  await assert.rejects(
    () => SettlementService.settleMatch(drawWinner.id, { result: 'DRAW', winnerId: u1.id, endReason: 'DRAW_AGREEMENT' }),
    (e) => e.name === 'InvalidSettlementError'
  );

  // A rejected board outcome never blocked a later valid claim on the same match.
  await prisma.matchMove.create({
    data: {
      matchId: noEvidence.id,
      moveNumber: 1,
      playerId: evLight.id,
      fromSquare: 1,
      toSquare: 2,
      capturedSquares: [],
      boardStateAfter: {}
    }
  });
  const retry = await SettlementService.settleMatch(noEvidence.id, {
    result: 'WIN', winnerId: evLight.id, endReason: 'NO_LEGAL_MOVES'
  });
  assert.equal(retry.claimed, true);
  assert.equal(retry.payout, PAYOUT);

  // None of the rejections left rows behind.
  for (const mid of [m.id, drawWinner.id]) {
    assert.equal(await prisma.matchSettlement.count({ where: { matchId: mid } }), 0);
    assert.equal(await prisma.matchReceipt.count({ where: { matchId: mid } }), 0);
    assert.equal(
      await prisma.ledgerTransaction.count({ where: { relatedMatchId: mid, type: 'SETTLEMENT_PAYOUT' } }),
      0
    );
    const still = await prisma.match.findUnique({ where: { id: mid } });
    assert.equal(still.status, 'IN_PLAY');
  }

  ok('P6 rejectable input writes nothing');
});

await run('P7 non-settleable matches throw and write nothing', async () => {
  await freshPair();
  // Never-started (FUNDED) match: not LIVE -> not settleable, and there is no
  // settlement record yet -> MatchNotSettleableError.
  const notStarted = await debitStakes(u1.id, u2.id, STAKE, 'AMATEUR');
  state.matches.push(notStarted.id);
  await assert.rejects(
    () => SettlementService.settleMatch(notStarted.id, { result: 'WIN', winnerId: u1.id, endReason: 'RESIGN' }),
    (e) => e.name === 'MatchNotSettleableError'
  );
  assert.equal((await prisma.match.findUnique({ where: { id: notStarted.id } })).status, 'FUNDED');
  assert.equal(await prisma.matchSettlement.count({ where: { matchId: notStarted.id } }), 0);

  // Unknown match id.
  await assert.rejects(
    () => SettlementService.settleMatch('00000000-0000-0000-0000-000000000000', { result: 'WIN', winnerId: u1.id }),
    (e) => e.name === 'MatchNotSettleableError'
  );

  ok('P7 non-settleable');
});

await run('P8 socket path end-to-end: redis cleanup and exactly-once notifications', async () => {
  await freshPair();
  const m = await fundMatch();
  await seedRedisLoop(m.id);

  const payload = await settleGameWithRetry(m.id, u1.id, u2.id, 'RESIGN');
  assert.ok(payload);
  assert.equal(payload.payout, PAYOUT);
  assert.equal(payload.commission, COMMISSION);
  assert.equal((await prisma.match.findUnique({ where: { id: m.id } })).status, 'SETTLED');

  assert.equal(await redis.get(`match:${m.id}`), null);
  assert.equal(await redis.get(`user:${u1.id}:activeMatch`), null);
  assert.equal(await redis.get(`user:${u2.id}:activeMatch`), null);

  const wins = await prisma.notification.count({ where: { userId: u1.id, type: 'MATCH_ENDED_WIN' } });
  const losses = await prisma.notification.count({ where: { userId: u2.id, type: 'MATCH_ENDED_LOSS' } });
  assert.equal(wins, 1);
  assert.equal(losses, 1);

  ok('P8 socket path');
});

await run('P9 restart-replay: gate-fired cleanup credits nothing, no duplicate notifications', async () => {
  await freshPair();
  const m = await fundMatch();

  // The DB txn commits (first call below), but the caller crashes before
  // cleanup. The retried settleGame hits the idempotency gate and runs
  // cleanup from DB state.
  await SettlementService.settleMatch(m.id, { result: 'WIN', winnerId: u1.id, endReason: 'RESIGN' });
  await seedRedisLoop(m.id);

  const payload = await settleGameWithRetry(m.id, u1.id, u2.id, 'STALE_RETRY');
  assert.ok(payload);

  const winner = await walletFor(u1.id);
  assert.equal(winner.balanceMinorUnits, 140_000n);
  assert.equal(
    await prisma.ledgerTransaction.count({ where: { relatedMatchId: m.id, type: 'SETTLEMENT_PAYOUT' } }),
    1
  );
  const payouts = await prisma.walletTransaction.findMany({ where: { relatedMatchId: m.id, type: 'PAYOUT' } });
  assert.equal(payouts.length, 1);

  const wins = await prisma.notification.count({ where: { userId: u1.id, type: 'MATCH_ENDED_WIN' } });
  const losses = await prisma.notification.count({ where: { userId: u2.id, type: 'MATCH_ENDED_LOSS' } });
  assert.equal(wins, 1);
  assert.equal(losses, 1);

  ok('P9 restart-replay');
});

await run('P10 closed book: every tx zero-sum, mirror reconciles to wallet deltas', async () => {
  await freshPair();
  const m = await fundMatch();
  const preAvailBal = await getAccountBalance(prisma, await accountId(u1.id, 'PLAYER_AVAILABLE'));
  await SettlementService.settleMatch(m.id, { result: 'WIN', winnerId: u1.id, endReason: 'RESIGN' });

  const { txs, bad } = await zeroSumPerTx(m.id);
  assert.deepEqual(bad, []);
  assert.deepEqual(
    txs.map((t) => t.type).sort(),
    ['SETTLEMENT_PAYOUT', 'STAKE_LOCK'].sort()
  );

  // Per-player ledger delta over the whole match lifecycle == signed legacy
  // WalletTransaction sum (STAKE -50000 then PAYOUT +90000 on the winner).
  for (const u of [u1, u2]) {
    const ledger = {};
    for (const type of ['PLAYER_AVAILABLE', 'PLAYER_LOCKED']) {
      const aId = await accountId(u.id, type);
      const sum = txs.reduce((acc, t) => acc + entrySumOf(t, aId), 0n);
      ledger[type] = sum;
    }
    const walletTxs = await prisma.walletTransaction.findMany({
      where: { relatedMatchId: m.id, wallet: { userId: u.id } }
    });
    const signed = walletTxs.reduce((acc, r) => acc + r.amountMinorUnits, 0n);
    // AVAILABLE - LOCKED = signed wallet movements for the match.
    assert.equal(ledger.PLAYER_AVAILABLE - ledger.PLAYER_LOCKED, signed);
  }

  // Winning AVAILABLE delta equals the payout exactly (50k out, 90k back).
  const postAvailBal = await getAccountBalance(prisma, await accountId(u1.id, 'PLAYER_AVAILABLE'));
  assert.equal(postAvailBal - preAvailBal, PAYOUT);

  ok('P10 closed book');
});

// ---------------------------------------------------------------------------

console.log(`\n${'='.repeat(64)}`);
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `  [${r.detail}]`}`);
}
console.log('='.repeat(64));
const failed = results.filter((r) => !r.pass).length;
console.log(`${results.length - failed}/${results.length} probes passed\n`);

// Cleanup: match-scoped ledger/wallet rows before matches/users.
try {
  for (const matchId of state.matches) {
    await prisma.matchMove.deleteMany({ where: { matchId } });
    await prisma.walletTransaction.deleteMany({ where: { relatedMatchId: matchId } });
    await prisma.ledgerTransaction.deleteMany({ where: { relatedMatchId: matchId } });
    await redis.del(`match:${matchId}`);
    await prisma.match.delete({ where: { id: matchId } });
  }
  await prisma.notification.deleteMany({
    where: { userId: { in: state.users } }
  });
  for (const userId of state.users) {
    await redis.del(`user:${userId}:activeMatch`);
    await prisma.walletTransaction.deleteMany({ where: { wallet: { userId } } });
    await prisma.wallet.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }
  console.log('cleanup: all probe rows removed');
} catch (e) {
  console.error('cleanup failed (manual review needed):', e.message);
  process.exitCode = 2;
}

await redis.quit();
await prisma.$disconnect();
process.exitCode = failed > 0 ? 1 : process.exitCode;