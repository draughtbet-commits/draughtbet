// Real-PostgreSQL + Redis integration for the "one pre-terminal match per
// player" invariant. Skipped by default; run:
//   DATABASE_URL=postgresql://test:test@127.0.0.1:5544/draughts_arena_test?schema=public \
//   REDIS_URL=redis://127.0.0.1:6390/0 RUN_REDIS_INTEGRATION=1 RUN_DB_INTEGRATION=1 \
//   node --experimental-vm-modules node_modules/jest/bin/jest.js \
//     src/services/__tests__/activeMatchReservation.integration.test.js
import { jest } from '@jest/globals';

const prisma = (await import('../../utils/db.js')).default;
const redis = (await import('../../utils/redis.js')).default;
const { ActiveMatchError, debitStakes } = await import('../matchService.js');
const { PRETTERMINAL_STATUSES } = await import('../../modules/match/service.js');
const { getUserLedgerProjections, ensureUserAccounts, ensureSystemAccount, postLedgerTransaction } = await import('../../services/ledgerService.js');
const { processGameActivationSweep } = await import('../../jobs/gameActivationSweep.js');
const { settleGameWithRetry } = await import('../../sockets/settlement.js');

const describeIntegration =
  process.env.RUN_REDIS_INTEGRATION === '1' ? describe : describe.skip;

describeIntegration('One pre-terminal match per player (real PostgreSQL + Redis)', () => {
  const settings = { id: 'singleton', commissionPercent: 10 };
  const allUsers = [];
  const allMatches = [];
  const allTxIds = [];

  // Seeds a wallet's opening balance as a ledger ADJUSTMENT (same shape as the
  // legacy backfill) so AVAILABLE == the balance everywhere below.
  const postOpeningBalance = async (wallet, amountMinorUnits) => {
    const res = await prisma.$transaction(async (tx) => {
      const accounts = await ensureUserAccounts(tx, wallet.userId, wallet.currency ?? 'NGN');
      const clearing = await ensureSystemAccount(tx, 'SYSTEM_OPENING_CLEARING', wallet.currency ?? 'NGN');
      return postLedgerTransaction(tx, {
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
    allTxIds.push(res.transaction.id);
  };

  const makeEligibleUser = async (suffix, balance = 10000000n) => {
    const user = await prisma.user.create({
      data: {
        email: `reserve-${Date.now()}-${Math.random()}-${suffix}@test.local`,
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
    allUsers.push(user.id);
    return user;
  };

  const stakeAndFund = async (a, b, stake = 1000000n) => {
    const match = await debitStakes(a.id, b.id, stake, 'PRO');
    allMatches.push(match.id);
    return match;
  };

  const balance = async (userId) => {
    const proj = await getUserLedgerProjections(prisma, userId);
    return BigInt(proj.available);
  };

  const pointer = (userId) => redis.get(`user:${userId}:activeMatch`);

  const cleanup = async () => {
    const userIds = [...allUsers];
    const matchIds = [...allMatches];
    const txIds = [...allTxIds];
    try {
      for (const matchId of matchIds) {
        await redis.del(`match:${matchId}`);
      }
      for (const uId of userIds) {
        await redis.del(`user:${uId}:activeMatch`);
      }

      if (userIds.length > 0 || matchIds.length > 0 || txIds.length > 0) {
        await prisma.$transaction(
          async (tx) => {
            // 1. Delete ledger entries & transactions BEFORE match/user/account teardown.
            const userAccounts = userIds.length
              ? await tx.ledgerAccount.findMany({
                  where: { userId: { in: userIds } },
                  select: { id: true }
                })
              : [];
            const accountIds = userAccounts.map((a) => a.id);

            const matchLedgerTxs = matchIds.length
              ? await tx.ledgerTransaction.findMany({
                  where: { relatedMatchId: { in: matchIds } },
                  select: { id: true }
                })
              : [];
            const allLedgerTxIds = [...new Set([...txIds, ...matchLedgerTxs.map((t) => t.id)])];

            if (allLedgerTxIds.length > 0 || accountIds.length > 0) {
              await tx.ledgerEntry.deleteMany({
                where: {
                  OR: [
                    ...(allLedgerTxIds.length > 0 ? [{ transactionId: { in: allLedgerTxIds } }] : []),
                    ...(accountIds.length > 0 ? [{ accountId: { in: accountIds } }] : [])
                  ]
                }
              });
            }
            if (allLedgerTxIds.length > 0) {
              await tx.ledgerTransaction.deleteMany({ where: { id: { in: allLedgerTxIds } } });
            }

            // 2. Delete match-scoped & user-scoped domain rows in dependency order.
            if (matchIds.length > 0) {
              await tx.matchMove.deleteMany({ where: { matchId: { in: matchIds } } });
              await tx.stakeReservation.deleteMany({ where: { matchId: { in: matchIds } } });
              await tx.gameOutbox.deleteMany({ where: { matchId: { in: matchIds } } });
              await tx.match.deleteMany({ where: { id: { in: matchIds } } });
            }
            if (userIds.length > 0) {
              await tx.notification.deleteMany({ where: { userId: { in: userIds } } });
              await tx.depositIntent.deleteMany({ where: { userId: { in: userIds } } });
              await tx.withdrawal.deleteMany({ where: { userId: { in: userIds } } });
              await tx.callout.deleteMany({
                where: { OR: [{ challengerId: { in: userIds } }, { opponentId: { in: userIds } }] }
              });
              await tx.ledgerAccount.deleteMany({ where: { userId: { in: userIds } } });
              await tx.wallet.deleteMany({ where: { userId: { in: userIds } } });
              await tx.user.deleteMany({ where: { id: { in: userIds } } });
            }
          },
          { timeout: 30_000 }
        );
      }

      allUsers.length = 0;
      allMatches.length = 0;
      allTxIds.length = 0;
    } catch (err) {
      console.error('[activeMatchReservation.integration.test] Cleanup failed:', err);
      throw err;
    }
  };

  beforeEach(async () => {
    await prisma.platformSettings.upsert({
      where: settings,
      create: settings,
      update: { commissionPercent: 10 }
    });
  }, 60_000);

  afterEach(cleanup, 60_000);

  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      await prisma.$disconnect();
    }
  }, 60_000);

  const countScopedPreterminalMatches = () =>
    prisma.match.count({
      where: {
        status: { in: PRETTERMINAL_STATUSES },
        OR: [{ playerLightId: { in: allUsers } }, { playerDarkId: { in: allUsers } }]
      }
    });

  it('refuses to fund a second pre-terminal match for a player already in one', async () => {
    const a = await makeEligibleUser('a');
    const b = await makeEligibleUser('b');
    const c = await makeEligibleUser('c');
    const d = await makeEligibleUser('d');

    const match1 = await stakeAndFund(a, b);
    await processGameActivationSweep();

    expect(await countScopedPreterminalMatches()).toBe(1);
    expect(await pointer(a.id)).toBe(match1.id);
    expect(await pointer(b.id)).toBe(match1.id);

    // Player a is already reserved — a fresh pair must be refused with NO
    // partial write (neither balance moved, no second ACTIVE match).
    await expect(stakeAndFund(a, c)).rejects.toBeInstanceOf(ActiveMatchError);
    await expect(stakeAndFund(d, b)).rejects.toBeInstanceOf(ActiveMatchError);

    expect(await balance(a.id)).toBe(9000000n);
    expect(await balance(b.id)).toBe(9000000n);
    expect(await balance(c.id)).toBe(10000000n);
    expect(await balance(d.id)).toBe(10000000n);
    expect(await countScopedPreterminalMatches()).toBe(1);
  });

  it('blocks the reservation on DB state even when Redis init never ran', async () => {
    const e = await makeEligibleUser('e');
    const f = await makeEligibleUser('f');
    const g = await makeEligibleUser('g');

    // Fund match1 but never run the activation sweep: the FUNDED row is the
    // only record, and it must still reserve both players.
    await stakeAndFund(e, f);

    await expect(stakeAndFund(e, g)).rejects.toBeInstanceOf(ActiveMatchError);
    expect(await countScopedPreterminalMatches()).toBe(1);
  });

  it('moves both stakes AVAILABLE -> LOCKED and records RESERVED StakeReservation rows', async () => {
    const a = await makeEligibleUser('exit-a');
    const b = await makeEligibleUser('exit-b');

    const match = await stakeAndFund(a, b);

    // One RESERVED stake reservation per player, at the authoritative amount.
    const reservations = await prisma.stakeReservation.findMany({
      where: { matchId: match.id },
      orderBy: { userId: 'asc' }
    });
    expect(reservations).toHaveLength(2);
    for (const r of reservations) {
      expect(r.status).toBe('RESERVED');
      expect(r.amountMinorUnits).toBe(1000000n);
    }

    // V2 ledger: each player moved 1M AVAILABLE -> LOCKED (>= the 1M stake).
    for (const user of [a, b]) {
      const proj = await getUserLedgerProjections(prisma, user.id);
      expect(proj.available).toBe('9000000');
      expect(proj.locked).toBe('1000000');
    }
  });

  it('clears the pointer when the owning match settles, freeing both players', async () => {
    const a = await makeEligibleUser('a');
    const b = await makeEligibleUser('b');

    const match1 = await stakeAndFund(a, b);
    await processGameActivationSweep();

    expect(await pointer(a.id)).toBe(match1.id);
    expect(await pointer(b.id)).toBe(match1.id);

    await settleGameWithRetry(match1.id, a.id, b.id, 'forfeit_disconnect');

    expect(await pointer(a.id)).toBeNull();
    expect(await pointer(b.id)).toBeNull();

    // The reservation is released: the same pair can immediately fund a rematch.
    const match2 = await stakeAndFund(a, b);
    expect(await countScopedPreterminalMatches()).toBe(1);
    expect(match2.id).not.toBe(match1.id);
    expect((await prisma.match.findUnique({ where: { id: match1.id } })).status).toBe('SETTLED');
  });

  it('cleanup compare-and-delete never wipes a pointer that points at a newer match', async () => {
    const a = await makeEligibleUser('a');
    const b = await makeEligibleUser('b');

    const match1 = await stakeAndFund(a, b);

    // Match must be live (IN_PLAY) before it can settle.
    await processGameActivationSweep();

    // Simulate a newer game started after match1: the pointers now belong to
    // 'ghost-match-2'. Settling match1 must NOT delete them.
    await redis.set(`user:${a.id}:activeMatch`, 'ghost-match-2');
    await redis.set(`user:${b.id}:activeMatch`, 'ghost-match-2');

    await settleGameWithRetry(match1.id, a.id, b.id, 'forfeit_disconnect');

    expect(await pointer(a.id)).toBe('ghost-match-2');
    expect(await pointer(b.id)).toBe('ghost-match-2');
    expect((await prisma.match.findUnique({ where: { id: match1.id } })).status).toBe('SETTLED');
  });
});