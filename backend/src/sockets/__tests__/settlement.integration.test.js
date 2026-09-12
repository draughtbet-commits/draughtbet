// Real-PostgreSQL S02+S16 integration test. Skipped by default; run:
//   DATABASE_URL=postgresql://test:test@127.0.0.1:5544/draughts_arena_test?schema=public \
//   REDIS_URL= RUN_DB_INTEGRATION=1 node --experimental-vm-modules node_modules/jest/bin/jest.js \
//     src/sockets/__tests__/settlement.integration.test.js
import prisma from '../../utils/db.js';
import { debitStakes, InsufficientFundsError } from '../../services/matchService.js';
import { settleGame, settleGameDraw } from '../settlement.js';

const describeIntegration =
  process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

describeIntegration('Settlement gate (real PostgreSQL)', () => {
  const settings = { id: 'singleton', commissionPercent: 10 };
  let u1;
  let u2;
  const allUsers = [];
  const allMatches = [];

  const makeUser = async (suffix, initialBalance = 100000n) => {
    const user = await prisma.user.create({
      data: { email: `settle-${Date.now()}-${Math.random()}-${suffix}@test.local`, passwordHash: 'x' }
    });
    await prisma.wallet.create({
      data: { userId: user.id, balanceMinorUnits: initialBalance }
    });
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
    return match;
  };

  beforeEach(async () => {
    [u1, u2] = await Promise.all([makeUser('a'), makeUser('b')]);
  });

  afterAll(async () => {
    for (const matchId of allMatches) {
      await prisma.matchMove.deleteMany({ where: { matchId } });
      await prisma.walletTransaction.deleteMany({ where: { relatedMatchId: matchId } });
      await prisma.match.delete({ where: { id: matchId } });
    }
    await prisma.walletTransaction.deleteMany({
      where: { wallet: { userId: { in: allUsers } } }
    });
    await prisma.wallet.deleteMany({ where: { userId: { in: allUsers } } });
    await prisma.user.deleteMany({ where: { id: { in: allUsers } } });
    await prisma.$disconnect();
  });

  it('funding debits both players, snapshots the fee, and debits reconcile to signed STAKE entries', async () => {
    const m = await fundMatch();


    expect(m.settlementCommissionPercent).toBe(10);

    for (const userId of [u1.id, u2.id]) {
      const w = await prisma.wallet.findUnique({ where: { userId } });
      expect(w.balanceMinorUnits.toString()).toBe('50000');

      const rows = await prisma.walletTransaction.findMany({
        where: { relatedMatchId: m.id, walletId: w.id },
        orderBy: { createdAt: 'asc' }
      });
      const signedSum = rows.reduce((acc, r) => acc + r.amountMinorUnits, 0n);
      expect(signedSum.toString()).toBe('-50000'); // exactly the STAKE debit
    }
  });

  it('competing win/win claims settle once: one winner, one PAYOUT, no commission entry', async () => {
    const m = await fundMatch();


    const [a, b] = await Promise.allSettled([
      settleGame(m.id, u1.id, u2.id, 'capture_win_a'),
      settleGame(m.id, u2.id, u1.id, 'capture_win_b')
    ]);

    const aWon = a.status === 'fulfilled' && a.value !== null;
    const bWon = b.status === 'fulfilled' && b.value !== null;
    // Exactly one of the two competing claims settles; the other is gated.
    expect(aWon).not.toBe(bWon);
    const winnerId = aWon ? u1.id : u2.id;

    const match = await prisma.match.findUnique({ where: { id: m.id } });
    expect(match.status).toBe('COMPLETED');
    expect(match.winnerId).toBe(winnerId);

    const payouts = await prisma.walletTransaction.findMany({
      where: { relatedMatchId: m.id, type: 'PAYOUT' }
    });
    const commissions = await prisma.walletTransaction.findMany({
      where: { relatedMatchId: m.id, type: 'COMMISSION' }
    });
    expect(payouts).toHaveLength(1);
    expect(commissions).toHaveLength(0);

    const winner = await prisma.wallet.findUnique({ where: { userId: winnerId } });
    const loser = await prisma.wallet.findUnique({
      where: { userId: winnerId === u1.id ? u2.id : u1.id }
    });
    expect(payouts[0].walletId).toBe(winner.id);
    expect(winner.balanceMinorUnits.toString()).toBe('140000'); // 50k left + 90k net
    expect(loser.balanceMinorUnits.toString()).toBe('50000');   // never credited
  });

  it('competing win vs draw produces exactly one outcome and one set of entries', async () => {
    const m = await fundMatch();


    const [win, draw] = await Promise.allSettled([
      settleGame(m.id, u1.id, u2.id, 'capture_win_race'),
      settleGameDraw(m.id, 'draw_race')
    ]);

    const outcomes = [win, draw].filter(r => r.status === 'fulfilled' && r.value !== null).length;
    expect(outcomes).toBe(1);
    if (win.status === 'rejected') throw win.reason;
    if (draw.status === 'rejected') throw draw.reason;

    const match = await prisma.match.findUnique({ where: { id: m.id } });
    expect(match.status).toBe('COMPLETED');

    const payouts = await prisma.walletTransaction.count({ where: { relatedMatchId: m.id, type: 'PAYOUT' } });
    const refunds = await prisma.walletTransaction.count({ where: { relatedMatchId: m.id, type: 'REFUND' } });

    if (payouts === 1) {
      expect(refunds).toBe(0);
      expect(match.winnerId).toBe(u1.id);
    } else {
      expect(refunds).toBe(2);
      expect(payouts).toBe(0);
      expect(match.winnerId).toBeNull();
    }
  });

  it('rejects an outsider winner before any write', async () => {
    const m = await fundMatch();


    await expect(settleGame(m.id, 'outsider-user', u2.id, 'capture_win'))
      .rejects.toThrow('Winner is not a participant');

    const match = await prisma.match.findUnique({ where: { id: m.id } });
    expect(match.status).toBe('ACTIVE');
    expect(await prisma.walletTransaction.count({ where: { relatedMatchId: m.id, type: 'PAYOUT' } })).toBe(0);
    for (const userId of [u1.id, u2.id]) {
      const w = await prisma.wallet.findUnique({ where: { userId } });
      expect(w.balanceMinorUnits.toString()).toBe('50000');
    }
  });

  it('replays (idempotency gate) neither re-pays nor rewrites ledger rows', async () => {
    const m = await fundMatch();


    const first = await settleGame(m.id, u1.id, u2.id, 'capture_win');
    const payoutsAfterFirst = await prisma.walletTransaction.count({
      where: { relatedMatchId: m.id, type: 'PAYOUT' }
    });

    const replay = await settleGame(m.id, u2.id, u1.id, 'capture_win_replay');
    expect(replay).toBeNull();

    expect(await prisma.walletTransaction.count({ where: { relatedMatchId: m.id, type: 'PAYOUT' } }))
      .toBe(payoutsAfterFirst);
    const winner = await prisma.wallet.findUnique({ where: { userId: u1.id } });
    expect(winner.balanceMinorUnits.toString()).toBe('140000');
    expect(first.payout.toString()).toBe('90000');
  });

it('winner ledger reconciles: signed PAYOUT equals the balance delta and fee stays within bounds', async () => {
    const m = await fundMatch();
    const pre = await prisma.wallet.findUnique({ where: { userId: u1.id } });
    await settleGame(m.id, u2.id, u1.id, 'capture_win');
    const post = await prisma.wallet.findUnique({ where: { userId: u2.id } });

    const rows = await prisma.walletTransaction.findMany({
      where: { relatedMatchId: m.id, walletId: post.id }
    });
    const signedSum = rows.reduce((acc, r) => acc + r.amountMinorUnits, 0n);

    // Balance change since funding equals the sum of this wallet's signed entries
    // for the match (STAKE -50000, then PAYOUT +90000).
    expect(post.balanceMinorUnits - 100000n).toBe(signedSum);

    // The settlement itself moves the winner exactly one signed PAYOUT entry.
    const payoutRow = rows.find(r => r.type === 'PAYOUT');
    expect(payoutRow).toBeDefined();
    expect(post.balanceMinorUnits - pre.balanceMinorUnits).toBe(payoutRow.amountMinorUnits);
    // Net payout = pot * (100 - snapshot)/100 (snapshot 10% -> 90000); no
    // negative COMMISSION row on the player wallet.
    expect(payoutRow.amountMinorUnits.toString()).toBe('90000');
  });

  it('InsufficientFundsError still throws when a participant cannot cover the stake', async () => {
    const poor = await makeUser('poor', 0n);
    await expect(
      debitStakes(u1.id, poor.id, 50000n, 'AMATEUR')
    ).rejects.toThrow(InsufficientFundsError);

    await prisma.wallet.delete({ where: { userId: poor.id } });
    await prisma.user.delete({ where: { id: poor.id } });
  });
});