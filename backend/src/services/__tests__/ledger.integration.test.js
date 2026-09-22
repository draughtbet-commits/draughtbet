// Real-PostgreSQL integration, gated by RUN_DB_INTEGRATION=1. Run:
//   DATABASE_URL=postgresql://draughts_arena:change_me_draughts_arena@localhost:5432/draughts_arena?schema=public \
//   RUN_DB_INTEGRATION=1 node --experimental-vm-modules node_modules/jest/bin/jest.js \
//     src/services/__tests__/ledger.integration.test.js
//
// Seeds funds through the V2 ledger (opening ADJUSTMENT) — the wallet row is a
// currency/lock holder only after the read-flip.
import prisma from '../../utils/db.js';
import {
  postLedgerTransaction,
  getUserLedgerProjections,
  ensureUserAccounts,
  ensureSystemAccount,
  UnbalancedPostingError
} from '../ledgerService.js';

const describeIntegration =
  process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

describeIntegration('LedgerService (real PostgreSQL)', () => {
  const createdUsers = [];
  const createdTxIds = [];

  const postOpening = async (userId, amountMinorUnits) => {
    const result = await prisma.$transaction(async (tx) => {
      const accounts = await ensureUserAccounts(tx, userId, 'NGN');
      const clearing = await ensureSystemAccount(tx, 'SYSTEM_OPENING_CLEARING');
      return postLedgerTransaction(tx, {
        type: 'ADJUSTMENT',
        description: 'test opening balance',
        idempotencyKey: `opening-balance:u:${userId}`,
        metadata: { source: 'ledger.integration.test' },
        entries: [
          { accountId: clearing.id, amountMinorUnits: -amountMinorUnits },
          { accountId: accounts.PLAYER_AVAILABLE.id, amountMinorUnits: amountMinorUnits }
        ]
      });
    });
    createdTxIds.push(result.transaction.id);
    return result;
  };

  const makeEligibleUser = async (initialBalance) => {
    const user = await prisma.user.create({
      data: {
        email: `ledger-${Date.now()}-${Math.random()}@test.local`,
        passwordHash: 'x',
        kycStatus: 'VERIFIED',
        countryCode: 'NG',
        eligibility: {
          create: { countryCode: 'NG', countryAllowed: true, ageVerified: true }
        }
      }
    });
    const wallet = await prisma.wallet.create({ data: { userId: user.id } });
    createdUsers.push(user.id);
    if (initialBalance > 0n) {
      await postOpening(user.id, initialBalance);
    }
    return { user, wallet };
  };

  const cleanup = async () => {
    for (const userId of createdUsers) {
      const wallet = await prisma.wallet.findUnique({ where: { userId } });
      if (wallet) {
        const accounts = await prisma.ledgerAccount.findMany({
          where: { userId },
          select: { id: true }
        });
        await prisma.ledgerEntry.deleteMany({
          where: { accountId: { in: accounts.map((a) => a.id) } }
        });
        await prisma.wallet.delete({ where: { id: wallet.id } });
      }
      await prisma.ledgerAccount.deleteMany({ where: { userId } });
      await prisma.user.delete({ where: { id: userId } });
    }
    // System singleton accounts keep their identity, but this suite's own
    // entries (opening-closing credits, revenue slices) must go so the shared
    // dev DB does not accumulate drift between runs.
    await prisma.ledgerEntry.deleteMany({
      where: { transactionId: { in: createdTxIds } }
    });
    await prisma.ledgerTransaction.deleteMany({
      where: { id: { in: createdTxIds } }
    });
    createdUsers.length = 0;
    createdTxIds.length = 0;
  };

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('seeds a wallet balance via the ledger and projections reflect it', async () => {
    const { user } = await makeEligibleUser(250000n);

    const projections = await getUserLedgerProjections(prisma, user.id);
    expect(projections.available).toBe('250000');
    expect(projections.locked).toBe('0');
    expect(projections.pending).toBe('0');
  });

  it('re-posting the opening balance is idempotent (no double credit)', async () => {
    const { user } = await makeEligibleUser(100000n);

    await postOpening(user.id, 100000n);

    const projections = await getUserLedgerProjections(prisma, user.id);
    expect(projections.available).toBe('100000');

    const account = await prisma.ledgerAccount.findFirst({
      where: { userId: user.id, type: 'PLAYER_AVAILABLE' }
    });
    const openingCount = await prisma.ledgerEntry.count({
      where: { accountId: account.id }
    });
    // re-run is replayed via the idempotency key: exactly one credit lands
    expect(openingCount).toBe(1);
  });

  it('a balanced stake reservation moves available -> locked and projections reflect it', async () => {
    const { user, wallet } = await makeEligibleUser(50000n);

    const accounts = await prisma.ledgerAccount.findMany({
      where: { userId: user.id }
    });
    const available = accounts.find((a) => a.type === 'PLAYER_AVAILABLE');
    const locked = accounts.find((a) => a.type === 'PLAYER_LOCKED');
    const clearing = await ensureSystemAccount(prisma, 'SYSTEM_OPENING_CLEARING');
    const revenue = await ensureSystemAccount(prisma, 'PLATFORM_REVENUE');

    const systemBalance = async (id) => {
      const agg = await prisma.ledgerEntry.aggregate({
        where: { accountId: id },
        _sum: { amountMinorUnits: true }
      });
      return agg._sum.amountMinorUnits ?? 0n;
    };
    const revenueBefore = await systemBalance(revenue.id);
    const clearingBefore = await systemBalance(clearing.id);

    const result = await prisma.$transaction(async (tx) =>
      postLedgerTransaction(tx, {
        type: 'STAKE_RESERVED',
        idempotencyKey: `stake-lock:${wallet.id}`,
        entries: [
          { accountId: available.id, amountMinorUnits: -50000n },
          { accountId: locked.id, amountMinorUnits: 49000n },
          { accountId: revenue.id, amountMinorUnits: 1000n }
        ]
      })
    );
    expect(result.replayed).toBe(false);
    expect(result.transaction.type).toBe('STAKE_RESERVED');
    createdTxIds.push(result.transaction.id);

    const projections = await getUserLedgerProjections(prisma, user.id);
    expect(projections.available).toBe('0');
    expect(projections.locked).toBe('49000');
    expect(projections.pending).toBe('0');

    // Platform revenue earned the 2% (1000 minor units) commission slice.
    expect((await systemBalance(revenue.id)) - revenueBefore).toBe(1000n);
    // The clearing contra only carried the opening (-50000) before this post;
    // the stake itself does not touch clearing.
    expect(await systemBalance(clearing.id)).toBe(clearingBefore);
  });

  it('rejects an unbalanced posting against real constraints', async () => {
    const { user, wallet } = await makeEligibleUser(10000n);

    const accounts = await prisma.ledgerAccount.findMany({
      where: { userId: user.id }
    });
    const available = accounts.find((a) => a.type === 'PLAYER_AVAILABLE');

    await expect(
      prisma.$transaction((tx) =>
        postLedgerTransaction(tx, {
          type: 'ADJUSTMENT',
          idempotencyKey: `unbalanced:${wallet.id}`,
          entries: [
            { accountId: available.id, amountMinorUnits: -10000n },
            { accountId: available.id, amountMinorUnits: 9000n }
          ]
        })
      )
    ).rejects.toThrow(UnbalancedPostingError);
  });
});