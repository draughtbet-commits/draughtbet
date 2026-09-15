// Real-PostgreSQL + Redis settlement integration test. Skipped by default; run:
//   DATABASE_URL=postgresql://test:test@127.0.0.1:5544/draughts_arena_test?schema=public \
//   REDIS_URL=redis://127.0.0.1:6390/0 RUN_REDIS_INTEGRATION=1 RUN_DB_INTEGRATION=1 \
//   node --experimental-vm-modules node_modules/jest/bin/jest.js \
//     src/sockets/__tests__/settlement.integration.test.js
import prisma from '../../utils/db.js';
import redis from '../../utils/redis.js';
import { debitStakes, InsufficientFundsError } from '../../services/matchService.js';
import { finalizeMatchActivation } from '../../services/gameActivationService.js';
import { settleGame, settleGameDraw } from '../settlement.js';
import { SYSTEM_ACCOUNT_ID } from '../../services/ledgerService.js';

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

  beforeEach(async () => {
    [u1, u2] = await Promise.all([makeUser('a'), makeUser('b')]);
  });

  afterAll(async () => {
    for (const matchId of allMatches) {
      await prisma.matchMove.deleteMany({ where: { matchId } });
      await prisma.walletTransaction.deleteMany({ where: { relatedMatchId: matchId } });
      await prisma.match.delete({ where: { id: matchId } });
      await redis.del(`match:${matchId}`);
    }
    for (const userId of allUsers) {
      await redis.del(`user:${userId}:activeMatch`);
    }
    await prisma.walletTransaction.deleteMany({
      where: { wallet: { userId: { in: allUsers } } }
    });
    await prisma.wallet.deleteMany({ where: { userId: { in: allUsers } } });
    // V2 ledger rows must go before users: user delete cascades LedgerAccount,
    // but LedgerEntry.account is onDelete Restrict.
    await prisma.ledgerTransaction.deleteMany({
      where: { relatedMatchId: { in: allMatches } }
    });
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

  it('competing win/win claims settle once: one winner, one PAYOUT, one terminal record', async () => {
    const m = await fundMatch();


    await Promise.allSettled([
      settleGame(m.id, u1.id, u2.id, 'capture_win_a'),
      settleGame(m.id, u2.id, u1.id, 'capture_win_b')
    ]);

    const match = await prisma.match.findUnique({ where: { id: m.id } });
    expect(match.status).toBe('SETTLED');
    expect([u1.id, u2.id]).toContain(match.winnerId);
    const winnerId = match.winnerId;

    const payouts = await prisma.walletTransaction.findMany({
      where: { relatedMatchId: m.id, type: 'PAYOUT' }
    });
    const commissions = await prisma.walletTransaction.findMany({
      where: { relatedMatchId: m.id, type: 'COMMISSION' }
    });
    expect(payouts).toHaveLength(1);
    expect(commissions).toHaveLength(0);

    // Exactly one terminal result record survives the race.
    expect(await prisma.matchSettlement.count({ where: { matchId: m.id } })).toBe(1);
    const settlement = await settingSettlement(m.id);
    expect(settlement.winnerId).toBe(winnerId);
    expect(settlement.status).toBe('SETTLED');

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


    await Promise.allSettled([
      settleGame(m.id, u1.id, u2.id, 'capture_win_race'),
      settleGameDraw(m.id, 'draw_race')
    ]);

    const match = await prisma.match.findUnique({ where: { id: m.id } });
    expect(match.status).toBe('SETTLED');

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
    expect(await prisma.walletTransaction.count({ where: { relatedMatchId: m.id, type: 'PAYOUT' } })).toBe(0);
    for (const userId of [u1.id, u2.id]) {
      const w = await prisma.wallet.findUnique({ where: { userId } });
      expect(w.balanceMinorUnits.toString()).toBe('50000');
    }
  });

  it('sweep and direct settlement racing on the same match yield one outcome and one PAYOUT', async () => {
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

    expect(await prisma.walletTransaction.count({
      where: { relatedMatchId: m.id, type: 'PAYOUT' }
    })).toBe(1);
    expect(await prisma.matchSettlement.count({ where: { matchId: m.id } })).toBe(1);

    const winner = await prisma.wallet.findUnique({ where: { userId: u1.id } });
    expect(winner.balanceMinorUnits.toString()).toBe('140000');
  });

  it('replays (idempotency gate) neither re-pays nor rewrites ledger rows', async () => {
    const m = await fundMatch();

    const first = await settleGame(m.id, u1.id, u2.id, 'capture_win');
    expect(first).not.toBeNull();

    const payoutsAfterFirst = await prisma.walletTransaction.count({
      where: { relatedMatchId: m.id, type: 'PAYOUT' }
    });

    // Replay names the other side — the outcome is preserved, not overridden.
    const replay = await settleGame(m.id, u2.id, u1.id, 'capture_win_replay');
    expect(replay.payout.toString()).toBe('90000');

    expect(await prisma.walletTransaction.count({ where: { relatedMatchId: m.id, type: 'PAYOUT' } }))
      .toBe(payoutsAfterFirst);
    expect(await prisma.matchSettlement.count({ where: { matchId: m.id } })).toBe(1);
    const winner = await prisma.wallet.findUnique({ where: { userId: u1.id } });
    expect(winner.balanceMinorUnits.toString()).toBe('140000');
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