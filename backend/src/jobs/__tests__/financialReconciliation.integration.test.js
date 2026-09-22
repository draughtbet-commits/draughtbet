// Real-PostgreSQL integration test for the financial reconciliation sweep.
// Run against a scratch Postgres with migrations:
//   DATABASE_URL=postgresql://test:test@127.0.0.1:5544/draughts_arena_test?schema=public \
//   REDIS_URL= RUN_DB_INTEGRATION=1 node --experimental-vm-modules node_modules/jest/bin/jest.js \
//     src/jobs/__tests__/financialReconciliation.integration.test.js
import crypto from 'crypto';
import prisma from '../../utils/db.js';
import { runFinancialReconciliation } from '../financialReconciliation.js';

const describeIntegration =
  process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

describeIntegration('Financial reconciliation (real PostgreSQL)', () => {
  const cleanups = [];
  let liabilityId = null;

  const cleanup = async () => {
    if (cleanups.length > 0) {
      await Promise.allSettled(cleanups.map((fn) => fn()));
    }
    cleanups.length = 0;
  };

  afterEach(cleanup);

  // The check asserts exactly ONE CUSTOMER_LIABILITY across the whole book, so
  // reuse any that already exists rather than ever creating a second one.
  const ensureLiability = async () => {
    if (liabilityId) return liabilityId;
    const existing = await prisma.ledgerAccount.findFirst({
      where: { type: 'CUSTOMER_LIABILITY', userId: null, currency: 'NGN' }
    });
    if (existing) {
      liabilityId = existing.id;
      return liabilityId;
    }
    const created = await prisma.ledgerAccount.create({
      data: { userId: null, type: 'CUSTOMER_LIABILITY', currency: 'NGN' }
    });
    liabilityId = created.id;
    return liabilityId;
  };

  // A user + wallet + one balanced deposit posting. Every fixture stays
  // zero-sum per transaction, so the closed-book invariant holds regardless of
  // what other tests have left in the shared scratch DB.
  const seedUserWithBalancedDeposit = async () => {
    const user = await prisma.user.create({
      data: {
        email: `finrec-${Date.now()}-${Math.random()}@test.local`,
        passwordHash: 'x',
        kycStatus: 'VERIFIED',
        countryCode: 'NG',
        eligibility: { create: { countryCode: 'NG', countryAllowed: true, ageVerified: true } }
      }
    });
    const wallet = await prisma.wallet.create({ data: { userId: user.id } });
    cleanups.push(() => prisma.user.deleteMany({ where: { id: user.id } }));

    const player = await prisma.ledgerAccount.create({
      data: { userId: user.id, type: 'PLAYER_AVAILABLE', currency: 'NGN' }
    });
    cleanups.push(() => prisma.ledgerAccount.deleteMany({ where: { id: player.id } }));

    const liability = await ensureLiability();
    const tx = await prisma.ledgerTransaction.create({
      data: {
        type: 'DEPOSIT_CONFIRMED',
        idempotencyKey: `deposit:credit:finrec-${crypto.randomUUID()}`,
        entries: {
          create: [
            { accountId: liability, amountMinorUnits: -100000n },
            { accountId: player.id, amountMinorUnits: 100000n }
          ]
        }
      }
    });
    cleanups.push(() => prisma.ledgerTransaction.deleteMany({ where: { id: tx.id } }));
    return { user, wallet, player };
  };

  it('passes a healthy double-entry book', async () => {
    await seedUserWithBalancedDeposit();

    const result = await runFinancialReconciliation();

    expect(result.status).toBe('PASSED');
    expect(result.discrepancies).toEqual([]);
  });

  it('flags a COMPLETED deposit intent that has no ledger credit posting', async () => {
    const { user, wallet } = await seedUserWithBalancedDeposit();
    const intent = await prisma.depositIntent.create({
      data: {
        userId: user.id,
        walletId: wallet.id,
        gateway: 'PAYSTACK',
        reference: `intent-${crypto.randomUUID()}`,
        amountMinorUnits: 25000n,
        currency: 'NGN',
        status: 'COMPLETED'
      }
    });
    cleanups.push(() => prisma.depositIntent.deleteMany({ where: { id: intent.id } }));

    const result = await runFinancialReconciliation();

    expect(result.status).toBe('FAILED');
    expect(result.discrepancies.join(' ')).toMatch(/deposit\.\S+\.credit/);
  });

  it('flags a PROCESSING withdrawal that already has a terminal posting', async () => {
    const { user, player } = await seedUserWithBalancedDeposit();
    const withdrawal = await prisma.withdrawal.create({
      data: {
        userId: user.id,
        amountMinorUnits: 50000n,
        reference: `wit-fr-${crypto.randomUUID()}`,
        gateway: 'PAYSTACK',
        status: 'PROCESSING'
      }
    });
    cleanups.push(() => prisma.withdrawal.deleteMany({ where: { id: withdrawal.id } }));
    const bogus = await prisma.ledgerTransaction.create({
      data: {
        type: 'WITHDRAWAL_CONFIRMED',
        idempotencyKey: `withdrawal:complete:${withdrawal.id}`,
        entries: {
          create: [
            { accountId: await ensureLiability(), amountMinorUnits: -50000n },
            { accountId: player.id, amountMinorUnits: 50000n }
          ]
        }
      }
    });
    cleanups.push(() => prisma.ledgerTransaction.deleteMany({ where: { id: bogus.id } }));

    const result = await runFinancialReconciliation();

    expect(result.status).toBe('FAILED');
    expect(result.discrepancies.join(' ')).toMatch(/withdrawal\.\S+\.no_terminal/);
  });
});