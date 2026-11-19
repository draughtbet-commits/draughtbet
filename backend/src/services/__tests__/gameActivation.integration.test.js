// Real-PostgreSQL + Redis activation lifecycle. Skipped by default; run:
//   DATABASE_URL=postgresql://test:test@127.0.0.1:5544/draughts_arena_test?schema=public \
//   REDIS_URL=redis://127.0.0.1:6390/0 RUN_REDIS_INTEGRATION=1 RUN_DB_INTEGRATION=1 \
//   node --experimental-vm-modules node_modules/jest/bin/jest.js \
//     src/services/__tests__/gameActivation.integration.test.js
import { jest } from '@jest/globals';

const prisma = (await import('../../utils/db.js')).default;
const redis = (await import('../../utils/redis.js')).default;
const { ensureSystemAccount } = await import('../ledgerService.js');
const { debitStakes } = await import('../matchService.js');
const {
  finalizeMatchActivation,
  MAX_ACTIVATION_ATTEMPTS
} = await import('../gameActivationService.js');
const { processGameActivationSweep } = await import('../../jobs/gameActivationSweep.js');

const describeIntegration =
  process.env.RUN_REDIS_INTEGRATION === '1' ? describe : describe.skip;

describeIntegration('Durable game activation (real PostgreSQL + Redis)', () => {
  const settings = { id: 'singleton', commissionPercent: 10 };
  const allUsers = [];
  const allMatches = [];

  const makeEligibleUser = async (suffix, balance = 10000000n) => {
    const user = await prisma.user.create({
      data: {
        email: `activation-${Date.now()}-${Math.random()}-${suffix}@test.local`,
        passwordHash: 'x',
        tier: 'PRO',
        kycStatus: 'VERIFIED',
        countryCode: 'NG',
        eligibility: {
          create: { countryCode: 'NG', countryAllowed: true, ageVerified: true }
        }
      }
    });
    await prisma.wallet.create({ data: { userId: user.id } });
    // Seed the spendable balance on the V2 ledger (PLAYER_AVAILABLE + BALANCE,
    // CUSTOMER_LIABILITY -BALANCE). The wallet row is a currency holder + lock
    // serialization point only.
    const liability = await ensureSystemAccount(prisma, 'CUSTOMER_LIABILITY', 'NGN');
    const available = await prisma.ledgerAccount.create({
      data: { userId: user.id, type: 'PLAYER_AVAILABLE', currency: 'NGN' }
    });
    const seed = await prisma.ledgerTransaction.create({
      data: { type: 'DEPOSIT_CREDIT', idempotencyKey: `activation:test:seed:${user.id}` }
    });
    await prisma.ledgerEntry.create({ data: { transactionId: seed.id, accountId: available.id, amountMinorUnits: balance } });
    await prisma.ledgerEntry.create({ data: { transactionId: seed.id, accountId: liability.id, amountMinorUnits: -balance } });
    allUsers.push(user.id);
    return user;
  };

  const stakeAndFund = async (a, b, stake = 1000000n) => {
    const match = await debitStakes(a.id, b.id, stake, 'PRO');
    allMatches.push(match.id);
    return match;
  };

  const outboxFor = async (matchId) =>
    prisma.gameOutbox.findUnique({ where: { matchId } });

  const ledgerCount = async (matchId) =>
    prisma.ledgerTransaction.count({ where: { relatedMatchId: matchId } });

  const balance = async (userId) => {
    const accounts = await prisma.ledgerAccount.findMany({
      where: { userId, type: 'PLAYER_AVAILABLE' }
    });
    if (accounts.length === 0) return 0n;
    const sum = await prisma.ledgerEntry.aggregate({
      where: { accountId: { in: accounts.map((a) => a.id) } },
      _sum: { amountMinorUnits: true }
    });
    return sum._sum.amountMinorUnits ?? 0n;
  };

  beforeEach(async () => {
    await prisma.platformSettings.upsert({
      where: settings,
      create: settings,
      update: { commissionPercent: 10 }
    });
  });

  afterAll(async () => {
    try {
      for (const matchId of allMatches) {
        await redis.del(`match:${matchId}`);
      }
      for (const userId of allUsers) {
        await redis.del(`user:${userId}:activeMatch`);
      }
      if (allUsers.length > 0 || allMatches.length > 0) {
        const seedKeys = allUsers.map((uId) => `activation:test:seed:${uId}`);
        await prisma.$transaction(
          async (tx) => {
            const userAccounts = allUsers.length
              ? await tx.ledgerAccount.findMany({
                  where: { userId: { in: allUsers } },
                  select: { id: true }
                })
              : [];
            const accountIds = userAccounts.map((a) => a.id);
            const txs = await tx.ledgerTransaction.findMany({
              where: {
                OR: [
                  ...(allMatches.length > 0 ? [{ relatedMatchId: { in: allMatches } }] : []),
                  ...(seedKeys.length > 0 ? [{ idempotencyKey: { in: seedKeys } }] : [])
                ]
              },
              select: { id: true }
            });
            const ledgerTxIds = txs.map((t) => t.id);

            if (ledgerTxIds.length > 0 || accountIds.length > 0) {
              await tx.ledgerEntry.deleteMany({
                where: {
                  OR: [
                    ...(ledgerTxIds.length > 0 ? [{ transactionId: { in: ledgerTxIds } }] : []),
                    ...(accountIds.length > 0 ? [{ accountId: { in: accountIds } }] : [])
                  ]
                }
              });
            }
            if (ledgerTxIds.length > 0) {
              await tx.ledgerTransaction.deleteMany({ where: { id: { in: ledgerTxIds } } });
            }
            if (allMatches.length > 0) {
              await tx.matchMove.deleteMany({ where: { matchId: { in: allMatches } } });
              await tx.gameOutbox.deleteMany({ where: { matchId: { in: allMatches } } });
              await tx.match.deleteMany({ where: { id: { in: allMatches } } });
            }
            if (allUsers.length > 0) {
              await tx.ledgerAccount.deleteMany({ where: { userId: { in: allUsers } } });
              await tx.wallet.deleteMany({ where: { userId: { in: allUsers } } });
              await tx.user.deleteMany({ where: { id: { in: allUsers } } });
            }
          },
          { timeout: 30_000 }
        );
      }
    } catch (err) {
      console.error('[gameActivation.integration.test] Cleanup failed:', err);
      throw err;
    } finally {
      await prisma.$disconnect();
    }
  }, 60_000);

  it('reconstructs a match whose funding committed but whose Redis init never ran', async () => {
    const p1 = await makeEligibleUser('p1');
    const p2 = await makeEligibleUser('p2');

    // The funding transaction commits (stakes reserved on the ledger + Match +
    // outbox) but nothing initializes Redis: this is the crash-after-commit
    // window.
    const match = await stakeAndFund(p1, p2);

    const outbox = await outboxFor(match.id);
    expect(outbox.status).toBe('PENDING');
    expect(await balance(p1.id)).toBe(9000000n);
    expect(await balance(p2.id)).toBe(9000000n);
    expect(await redis.exists(`match:${match.id}`)).toBe(0);

    // The recovery sweep reconstructs the game without touching anyone's money.
    await processGameActivationSweep();

    const after = await outboxFor(match.id);
    expect(after.status).toBe('ACTIVATED');
    expect(await redis.exists(`match:${match.id}`)).toBe(1);
    expect(await redis.get(`user:${p1.id}:activeMatch`)).toBe(match.id);
    expect(await redis.get(`user:${p2.id}:activeMatch`)).toBe(match.id);
    expect(await balance(p1.id)).toBe(9000000n);
    expect(await balance(p2.id)).toBe(9000000n);
    // ONE balanced STAKE_LOCK posting for the pair; activation never re-debits.
    expect(await ledgerCount(match.id)).toBe(1);

    const state = await redis.hgetall(`match:${match.id}`);
    expect(state.board).toBeTruthy();
    expect(state.status).toBe('in_progress');
  });

  it('reclaims a stale ACTIVATING lease and finishes the activation', async () => {
    const p1 = await makeEligibleUser('stale-1');
    const p2 = await makeEligibleUser('stale-2');
    const match = await stakeAndFund(p1, p2);

    // Simulate an owner who claimed the row then died mid-activation.
    await prisma.gameOutbox.update({
      where: { matchId: match.id },
      data: {
        status: 'ACTIVATING',
        claimToken: 'dead-owner-token',
        claimExpiresAt: new Date(Date.now() - 60_000)
      }
    });

    await processGameActivationSweep();

    const outbox = await outboxFor(match.id);
    expect(outbox.status).toBe('ACTIVATED');
    expect(outbox.claimToken).toBeNull();
    expect(await redis.exists(`match:${match.id}`)).toBe(1);
    // Exactly the funding posting; activation never re-debits
    expect(await ledgerCount(match.id)).toBe(1);
  });

  it('does not clobber a game Redis already made live', async () => {
    const p1 = await makeEligibleUser('live-1');
    const p2 = await makeEligibleUser('live-2');
    const match = await stakeAndFund(p1, p2);

    // The Redis init ran but the process died before marking ACTIVATED.
    const { initializeGame } = await import('../../sockets/gameManager.js');
    await initializeGame(match.id, p1.id, p2.id, 'PRO');
    await prisma.gameOutbox.update({
      where: { matchId: match.id },
      data: { status: 'PENDING', claimToken: null, claimExpiresAt: null }
    });

    await finalizeMatchActivation((await outboxFor(match.id)).id);

    const outbox = await outboxFor(match.id);
    expect(outbox.status).toBe('ACTIVATED');
    // The live state was left intact
    expect(await redis.exists(`match:${match.id}`)).toBe(1);
    expect(await ledgerCount(match.id)).toBe(1);
  });

  it('releases a match that exhausted activation attempts: refunds exactly once', async () => {
    const p1 = await makeEligibleUser('rel-1');
    const p2 = await makeEligibleUser('rel-2');
    const match = await stakeAndFund(p1, p2);

    // Exhaust the attempt budget so the sweep takes the release branch.
    await prisma.gameOutbox.update({
      where: { matchId: match.id },
      data: {
        status: 'PENDING',
        claimToken: null,
        claimExpiresAt: null,
        attempts: MAX_ACTIVATION_ATTEMPTS
      }
    });

    await processGameActivationSweep();

    const outbox = await outboxFor(match.id);
    expect(outbox.status).toBe('RELEASED');

    const dbMatch = await prisma.match.findUnique({ where: { id: match.id } });
    expect(dbMatch.status).toBe('RELEASED');

    // Both stakes credited back; the funding posting is untouched
    expect(await balance(p1.id)).toBe(10000000n);
    expect(await balance(p2.id)).toBe(10000000n);
    expect(await ledgerCount(match.id)).toBe(2); // STAKE_LOCK + one STAKE_RELEASE

    // A second sweep cannot refund again
    await processGameActivationSweep();
    expect(await balance(p1.id)).toBe(10000000n);
    expect(await ledgerCount(match.id)).toBe(2);
  });
});