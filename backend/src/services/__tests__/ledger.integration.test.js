// Real-PostgreSQL integration, gated by RUN_DB_INTEGRATION=1. Run:
//   DATABASE_URL=postgresql://draughts_arena:change_me_draughts_arena@localhost:5432/draughts_arena?schema=public \
//   RUN_DB_INTEGRATION=1 node --experimental-vm-modules node_modules/jest/bin/jest.js \
//     src/services/__tests__/ledger.integration.test.js
//
// Exit gate for PR 2: every legacy wallet reconciles to its ledger available.
import prisma from '../../utils/db.js';
import {
  backfillAndReconcileAllWallets,
  postLedgerTransaction,
  getUserLedgerProjections,
  ensureSystemAccount,
  UnbalancedPostingError
} from '../ledgerService.js';

const describeIntegration =
  process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

describeIntegration('LedgerService (real PostgreSQL)', () => {
  const createdUsers = [];
  const createdTxIds = [];

  const makeEligibleUser = async (balanceMinorUnits) => {
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
    const wallet = await prisma.wallet.create({
      data: { userId: user.id, balanceMinorUnits }
    });
    createdUsers.push(user.id);
    return { user, wallet };
  };

  // Backfills every wallet AND records each opening transaction so cleanup can
  // remove the system-account entries without touching unrelated data.
  const runBackfill = async () => {
    const summary = await backfillAndReconcileAllWallets();
    for (const row of summary.results) {
      if (row.transactionId) createdTxIds.push(row.transactionId);
    }
    return summary;
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
        await prisma.walletTransaction.deleteMany({ where: { walletId: wallet.id } });
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

  it('backfills a wallet and the ledger available equals the legacy balance', async () => {
    const { user, wallet } = await makeEligibleUser(250000n);

    const result = await runBackfill();
    const row = result.results.find((r) => r.walletId === wallet.id);

    expect(row).toBeDefined();
    expect(row.reconciled).toBe(true);
    expect(row.available).toBe('250000');
    createdTxIds.push(row.transactionId);

    const projections = await getUserLedgerProjections(prisma, user.id);
    expect(projections.available).toBe('250000');
    expect(projections.locked).toBe('0');
    expect(projections.pending).toBe('0');
  });

  it('re-run backfill is idempotent (no double credit)', async () => {
    const { user, wallet } = await makeEligibleUser(100000n);

    await runBackfill();
    await runBackfill();

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

  it('a balanced STAKE_LOCK moves available -> locked and projections reflect it', async () => {
    const { user, wallet } = await makeEligibleUser(50000n);
    await runBackfill();

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
        type: 'STAKE_LOCK',
        idempotencyKey: `stake-lock:${wallet.id}`,
        entries: [
          { accountId: available.id, amountMinorUnits: -50000n },
          { accountId: locked.id, amountMinorUnits: 49000n },
          { accountId: revenue.id, amountMinorUnits: 1000n }
        ]
      })
    );
    expect(result.replayed).toBe(false);
    expect(result.transaction.type).toBe('STAKE_LOCK');
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
    await runBackfill();

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