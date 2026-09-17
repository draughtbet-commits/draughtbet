// Real-PostgreSQL + Redis settlement integration test. Skipped by default; run:
//   DATABASE_URL=postgresql://test:test@127.0.0.1:5544/draughts_arena_test?schema=public \
//   REDIS_URL=redis://127.0.0.1:6390/0 RUN_REDIS_INTEGRATION=1 RUN_DB_INTEGRATION=1 \
//   node --experimental-vm-modules node_modules/jest/bin/jest.js \
//     src/sockets/__tests__/settlement.integration.test.js
import prisma from '../../utils/db.js';
import redis from '../../utils/redis.js';
import http from 'node:http';
import { debitStakes, InsufficientFundsError } from '../../services/matchService.js';
import { finalizeMatchActivation } from '../../services/gameActivationService.js';
import { settleGame, settleGameDraw } from '../settlement.js';
import { initSocketServer } from '../index.js';
import { SYSTEM_ACCOUNT_ID, getUserLedgerProjections, ensureUserAccounts, ensureSystemAccount, postLedgerTransaction } from '../../services/ledgerService.js';

const describeIntegration =
  process.env.RUN_DB_INTEGRATION === '1' && process.env.RUN_REDIS_INTEGRATION === '1'
    ? describe
    : describe.skip;

describeIntegration('Settlement gate (real PostgreSQL)', () => {
  const settings = { id: 'singleton', commissionPercent: 10 };
  let u1;
  let u2;
  const allUsers = [];
  const allMatches = [];

  // Seeds a wallet's opening balance as a ledger ADJUSTMENT (same shape as the
  // legacy backfill) so AVAILABLE == the legacy wallet balance everywhere.
  const postOpeningBalance = async (wallet, amountMinorUnits) => {
    await prisma.$transaction(async (tx) => {
      const accounts = await ensureUserAccounts(tx, wallet.userId, wallet.currency ?? 'NGN');
      const clearing = await ensureSystemAccount(tx, 'SYSTEM_OPENING_CLEARING', wallet.currency ?? 'NGN');
      await postLedgerTransaction(tx, {
        type: 'ADJUSTMENT',
        description: 'Opening balance carried over from legacy wallet',
        idempotencyKey: `opening-balance:${wallet.id}`,
        metadata: { walletId: wallet.id, source: 'legacy-wallet-backfill' },
        entries: [
          { accountId: clearing.id, amountMinorUnits: -amountMinorUnits },
          { accountId: accounts.PLAYER_AVAILABLE.id, amountMinorUnits: amountMinorUnits }
        ]
      });
    });
  };

  const makeUser = async (suffix, initialBalance = 100000n) => {
    const user = await prisma.user.create({
      data: {
        email: `settle-${Date.now()}-${Math.random()}-${suffix}@test.local`,
        passwordHash: 'x',
        kycStatus: 'VERIFIED',
        countryCode: 'NG',
        eligibility: {
          create: { countryCode: 'NG', countryAllowed: true, ageVerified: true }
        }
      }
    });
    const wallet = await prisma.wallet.create({ data: { userId: user.id } });
    // A zero opening means "no funds" — leave the ledger untouched so
    // getLedgerAvailable resolves to 0n and the funding path rejects.
    if (initialBalance > 0n) await postOpeningBalance(wallet, initialBalance);
    allUsers.push(user.id);
    return user;
  };

  const fundMatch = async () => {
    await prisma.platformSettings.upsert({
      where: settings,
      create: settings,
      update: { commissionPercent: 10 }
    });
    const match = await debitStakes(u1.id, u2.id, 50000n, 'AMATEUR');
    allMatches.push(match.id);
    // Settlement is only legal once the match is LIVE. Activate (server-
    // authoritative start) so the row advances FUNDED -> IN_PLAY exactly as
    // production does; a never-started match must NOT be settlable.
    const outbox = await prisma.gameOutbox.findUnique({
      where: { matchId: match.id },
      select: { id: true }
    });
    await finalizeMatchActivation(outbox.id);
    return match;
  };

  const settingSettlement = async (matchId) => {
    return prisma.matchSettlement.findUnique({ where: { matchId } });
  };

  const available = async (userId) => {
    const proj = await getUserLedgerProjections(prisma, userId);
    return BigInt(proj.available);
  };

  const basketTx = (matchId, type) =>
    prisma.ledgerTransaction.findMany({
      where: { relatedMatchId: matchId, type },
      include: { entries: true }
    });

  beforeEach(async () => {
    [u1, u2] = await Promise.all([makeUser('a'), makeUser('b')]);
  });

  beforeAll(async () => {
    // A real Socket.IO server so post-settlement emits and the notification
    // rows actually write (without one, getIO() is undefined and the cleanup
    // path bails before creating them).
    initSocketServer(http.createServer());
  });

  afterAll(async () => {
    for (const matchId of allMatches) {
      await prisma.matchMove.deleteMany({ where: { matchId } });
      await prisma.match.delete({ where: { id: matchId } });
      await redis.del(`match:${matchId}`);
    }
    for (const userId of allUsers) {
      await redis.del(`user:${userId}:activeMatch`);
    }
    await prisma.wallet.deleteMany({ where: { userId: { in: allUsers } } });
    // V2 ledger rows must go before users: user delete cascades LedgerAccount,
    // but LedgerEntry.account is onDelete Restrict.
    await prisma.ledgerTransaction.deleteMany({
      where: { relatedMatchId: { in: allMatches } }
    });
    // Opening-balance backfill transactions carry no matchId; their entries sit
    // in these users' accounts and would also block the user delete.
    await prisma.ledgerEntry.deleteMany({
      where: { account: { userId: { in: allUsers } } }
    });
    await prisma.ledgerTransaction.deleteMany({
      where: { metadata: { path: ['source'], equals: 'legacy-wallet-backfill' } }
    });
    await prisma.notification.deleteMany({
      where: { userId: { in: allUsers } }
    });
    await prisma.user.deleteMany({ where: { id: { in: allUsers } } });
    await prisma.$disconnect();
  });

  it('funding debits both players, snapshots the fee, and posts a balanced STAKE_LOCK', async () => {
    const m = await fundMatch();

    expect(m.settlementCommissionPercent).toBe(10);

    for (const userId of [u1.id, u2.id]) {
      // STAKE -50000 on each player leaves AVAILABLE at 50000 (legacy-equivalent).
      expect(await available(userId)).toBe(50000n);
    }

    const stakeTx = await basketTx(m.id, 'STAKE_LOCK');
    expect(stakeTx).toHaveLength(1);
    expect(stakeTx[0].entries.reduce((acc, e) => acc + e.amountMinorUnits, 0n)).toBe(0n);
  });

  it('competing win/win claims settle once: one winner, one balancing posting, one terminal record', async () => {
    const m = await fundMatch();

    await Promise.allSettled([
      settleGame(m.id, u1.id, u2.id, 'capture_win_a'),
      settleGame(m.id, u2.id, u1.id, 'capture_win_b')
    ]);

    const match = await prisma.match.findUnique({ where: { id: m.id } });
    expect(match.status).toBe('SETTLED');
    expect([u1.id, u2.id]).toContain(match.winnerId);
    const winnerId = match.winnerId;
    const loserId = winnerId === u1.id ? u2.id : u1.id;

    const payoutTxs = await basketTx(m.id, 'SETTLEMENT_PAYOUT');
    expect(payoutTxs).toHaveLength(1);

    // Exactly one terminal result record survives the race.
    expect(await prisma.matchSettlement.count({ where: { matchId: m.id } })).toBe(1);
    const settlement = await settingSettlement(m.id);
    expect(settlement.winnerId).toBe(winnerId);
    expect(settlement.status).toBe('SETTLED');

    const winnerAccount = await prisma.ledgerAccount.findUnique({
      where: { userId_type_currency: { userId: winnerId, type: 'PLAYER_AVAILABLE', currency: 'NGN' } }
    });
    const winnerEntry = payoutTxs[0].entries.find((e) => e.accountId === winnerAccount.id);
    expect(winnerEntry).toBeDefined();
    expect(winnerEntry.amountMinorUnits.toString()).toBe('90000');

    // Winner: 50k left + 90k net. Loser: 50k left, never credited.
    expect(await available(winnerId)).toBe(140000n);
    expect(await available(loserId)).toBe(50000n);

    // The race fired the idempotency gate for one caller; the replay-side
    // cleanup must never stack a second WIN/LOSS notification.
    expect(await prisma.notification.count({
      where: { userId: winnerId, matchId: m.id, type: 'MATCH_ENDED_WIN' }
    })).toBe(1);
    expect(await prisma.notification.count({
      where: { userId: loserId, matchId: m.id, type: 'MATCH_ENDED_LOSS' }
    })).toBe(1);
  });

  it('competing win vs draw produces exactly one outcome and one settlement posting', async () => {
    const m = await fundMatch();

    await Promise.allSettled([
      settleGame(m.id, u1.id, u2.id, 'capture_win_race'),
      settleGameDraw(m.id, 'draw_race')
    ]);

    const match = await prisma.match.findUnique({ where: { id: m.id } });
    expect(match.status).toBe('SETTLED');

    // Exactly one settlement posting regardless of which claim won.
    const payoutTxs = await basketTx(m.id, 'SETTLEMENT_PAYOUT');
    expect(payoutTxs).toHaveLength(1);

    if (match.winnerId) {
      expect(match.winnerId).toBe(u1.id);
      expect(await available(u1.id)).toBe(140000n);
      expect(await available(u2.id)).toBe(50000n);
    } else {
      expect(await available(u1.id)).toBe(100000n);
      expect(await available(u2.id)).toBe(100000n);
    }

    expect(await prisma.matchSettlement.count({ where: { matchId: m.id } })).toBe(1);
  });

  it('rejects an outsider winner before any write', async () => {
    const m = await fundMatch();

    await expect(settleGame(m.id, 'outsider-user', u2.id, 'capture_win'))
      .rejects.toThrow('Winner is not a participant');

    // Activated matches are IN_PLAY until claimed; an outsider rejection leaves
    // the live match untouched.
    const match = await prisma.match.findUnique({ where: { id: m.id } });
    expect(match.status).toBe('IN_PLAY');
    expect(await basketTx(m.id, 'SETTLEMENT_PAYOUT')).toHaveLength(0);
    for (const userId of [u1.id, u2.id]) {
      expect(await available(userId)).toBe(50000n);
    }
  });

  it('sweep and direct settlement racing on the same match yield one outcome and one posting', async () => {
    const m = await fundMatch();

    // Mirrors reconciliationSweep vs the winning move's own settleGameWithRetry.
    await Promise.allSettled([
      settleGame(m.id, u1.id, u2.id, 'capture_win'),
      settleGame(m.id, u1.id, u2.id, 'recovery_sweep')
    ]);

    const match = await prisma.match.findUnique({ where: { id: m.id } });
    expect(match.status).toBe('SETTLED');
    expect(match.winnerId).toBe(u1.id);
    expect(['capture_win', 'recovery_sweep']).toContain(match.endReason);

    expect(await basketTx(m.id, 'SETTLEMENT_PAYOUT')).toHaveLength(1);
    expect(await prisma.matchSettlement.count({ where: { matchId: m.id } })).toBe(1);

    expect(await available(u1.id)).toBe(140000n);
  });

  it('replays (idempotency gate) neither re-pays nor rewrites ledger postings', async () => {
    const m = await fundMatch();

    const first = await settleGame(m.id, u1.id, u2.id, 'capture_win');
    expect(first).not.toBeNull();

    expect(await basketTx(m.id, 'SETTLEMENT_PAYOUT')).toHaveLength(1);

    // Replay names the other side — the outcome is preserved, not overridden.
    const replay = await settleGame(m.id, u2.id, u1.id, 'capture_win_replay');
    expect(replay.payout.toString()).toBe('90000');

    expect(await basketTx(m.id, 'SETTLEMENT_PAYOUT')).toHaveLength(1);
    expect(await prisma.matchSettlement.count({ where: { matchId: m.id } })).toBe(1);
    expect(await available(u1.id)).toBe(140000n);
    expect(first.payout.toString()).toBe('90000');
  });

  it('records the terminal result, receipts, and a balanced winner ledger posting', async () => {
    const m = await fundMatch();
    await settleGame(m.id, u1.id, u2.id, 'capture_win');

    // Terminal result record with the frozen fee and net payout.
    const settlement = await settingSettlement(m.id);
    expect(settlement.status).toBe('SETTLED');
    expect(settlement.settledAt).not.toBeNull();
    expect(settlement.winnerId).toBe(u1.id);
    expect(settlement.endReason).toBe('capture_win');
    expect(settlement.feeSnapshotBps).toBe(10); // frozen funding-time percent
    expect(settlement.netPayoutMinorUnits.toString()).toBe('90000');

    // Per-player receipts.
    const receipts = await prisma.matchReceipt.findMany({ where: { matchId: m.id } });
    expect(receipts).toHaveLength(2);
    const winnerR = receipts.find((r) => r.userId === u1.id);
    const loserR = receipts.find((r) => r.userId === u2.id);
    expect(winnerR.stakeMinorUnits.toString()).toBe('50000');
    expect(winnerR.payoutMinorUnits.toString()).toBe('90000');
    expect(winnerR.feeMinorUnits.toString()).toBe('10000');
    expect(loserR.stakeMinorUnits.toString()).toBe('50000');
    expect(loserR.payoutMinorUnits.toString()).toBe('0');
    expect(loserR.feeMinorUnits.toString()).toBe('0');

    // The settlement ledger posting: winner avail + net, platform rev + fee,
    // both locks closed, and the whole posting sums to zero.
    const txs = await prisma.ledgerTransaction.findMany({
      where: { relatedMatchId: m.id },
      include: { entries: true }
    });
    const payoutTx = txs.find((t) => t.type === 'SETTLEMENT_PAYOUT');
    expect(payoutTx).toBeDefined();
    expect(payoutTx.idempotencyKey).toBe(`MATCH_SETTLEMENT:${m.id}`);

    const signed = payoutTx.entries.reduce((acc, e) => acc + e.amountMinorUnits, 0n);
    expect(signed).toBe(0n);

    const winnerAccount = await prisma.ledgerAccount.findUnique({
      where: { userId_type_currency: { userId: u1.id, type: 'PLAYER_AVAILABLE', currency: 'NGN' } }
    });
    const loserLockAccount = await prisma.ledgerAccount.findUnique({
      where: { userId_type_currency: { userId: u2.id, type: 'PLAYER_LOCKED', currency: 'NGN' } }
    });
    const winnerEntry = payoutTx.entries.find((e) => e.accountId === winnerAccount.id);
    const loserLockEntry = payoutTx.entries.find((e) => e.accountId === loserLockAccount.id);
    expect(winnerEntry.amountMinorUnits.toString()).toBe('90000');
    expect(loserLockEntry.amountMinorUnits.toString()).toBe('-50000');

    const revenueAccount = await prisma.ledgerAccount.findUnique({
      where: { id: SYSTEM_ACCOUNT_ID('PLATFORM_REVENUE', 'NGN') }
    });
    const revenueEntry = payoutTx.entries.find((e) => e.accountId === revenueAccount.id);
    expect(revenueEntry.amountMinorUnits.toString()).toBe('10000');

    // The reservations left RESERVED at funding complete to SETTLED in the
    // settlement transaction.
    const reservations = await prisma.stakeReservation.findMany({ where: { matchId: m.id } });
    expect(reservations).toHaveLength(2);
    expect(reservations.every((r) => r.status === 'SETTLED')).toBe(true);
  });

  it('draw returns both stakes and records netPayout as the pot with zero commission', async () => {
    const m = await fundMatch();
    await settleGameDraw(m.id, 'draw_agreement');

    const settlement = await settingSettlement(m.id);
    expect(settlement.status).toBe('SETTLED');
    expect(settlement.winnerId).toBeNull();
    expect(settlement.endReason).toBe('draw_agreement');
    // A draw returns the whole pot; the record must not carry a win-style
    // pot-minus-commission value.
    expect(settlement.netPayoutMinorUnits.toString()).toBe('100000');

    expect(await available(u1.id)).toBe(100000n);
    expect(await available(u2.id)).toBe(100000n);

    const txs = await prisma.ledgerTransaction.findMany({
      where: { relatedMatchId: m.id },
      include: { entries: true }
    });
    const payoutTx = txs.find((t) => t.type === 'SETTLEMENT_PAYOUT');
    expect(payoutTx).toBeDefined();
    expect(payoutTx.entries.reduce((acc, e) => acc + e.amountMinorUnits, 0n)).toBe(0n);
    const revenueAccount = await prisma.ledgerAccount.findUnique({
      where: { id: SYSTEM_ACCOUNT_ID('PLATFORM_REVENUE', 'NGN') }
    });
    expect(payoutTx.entries.some((e) => e.accountId === revenueAccount.id)).toBe(false);

    const receipts = await prisma.matchReceipt.findMany({ where: { matchId: m.id } });
    expect(receipts).toHaveLength(2);
    expect(receipts.every((r) =>
      r.stakeMinorUnits === 50000n && r.payoutMinorUnits === 50000n && r.feeMinorUnits === 0n
    )).toBe(true);

    const reservations = await prisma.stakeReservation.findMany({ where: { matchId: m.id } });
    expect(reservations.every((r) => r.status === 'SETTLED')).toBe(true);
  });

  it('winner ledger reconciles: the settlement posting carries exactly the net PAYOUT to AVAILABLE', async () => {
    const m = await fundMatch();
    await settleGame(m.id, u2.id, u1.id, 'capture_win');

    // The winner's AVAILABLE moved by exactly the signed net payout entry.
    const winnerAccount = await prisma.ledgerAccount.findUnique({
      where: { userId_type_currency: { userId: u2.id, type: 'PLAYER_AVAILABLE', currency: 'NGN' } }
    });
    const payoutTx = (await basketTx(m.id, 'SETTLEMENT_PAYOUT'))[0];
    expect(payoutTx).toBeDefined();
    const payoutEntry = payoutTx.entries.find((e) => e.accountId === winnerAccount.id);

    // Net payout = pot * (100 - snapshot)/100 (snapshot 10% -> 90000); the win
    // credit lands exactly once and fully in AVAILABLE. The winner lost their
    // 50k stake and received the 90k net payout: 100000 - 50000 + 90000.
    expect(payoutEntry.amountMinorUnits.toString()).toBe('90000');
    expect(await available(u2.id)).toBe(140000n);
    expect(await available(u1.id)).toBe(50000n);
  });

  it('InsufficientFundsError still throws when a participant cannot cover the stake', async () => {
    const poor = await makeUser('poor', 0n);
    await expect(
      debitStakes(u1.id, poor.id, 50000n, 'AMATEUR')
    ).rejects.toThrow(InsufficientFundsError);

    // The failed funding posted nothing: no wallet debit, no ledger posting.
    await prisma.wallet.delete({ where: { userId: poor.id } });
    await prisma.user.delete({ where: { id: poor.id } });
  });
});