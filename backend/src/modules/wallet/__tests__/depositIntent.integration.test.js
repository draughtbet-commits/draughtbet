// Real-PostgreSQL integration test for the S08 payment-intent fix. The
// default suite runs with no DB (skipped); run it against a scratch Postgres
// with migrations applied:
//   DATABASE_URL=postgresql://test:test@127.0.0.1:5544/draughts_arena_test?schema=public \
//   REDIS_URL= RUN_DB_INTEGRATION=1 node --experimental-vm-modules node_modules/jest/bin/jest.js \
//     src/modules/wallet/__tests__/depositIntent.integration.test.js
import prisma from '../../../utils/db.js';
import { createDepositIntent, processDepositWebhook } from '../service.js';
import { reconcileDeposits } from '../../../jobs/depositReconciliation.js';

const describeIntegration =
  process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

describeIntegration('Deposit intents (real PostgreSQL)', () => {
  let userId;
  let walletId;

  const createFixture = async () => {
    const user = await prisma.user.create({
      data: {
        email: `s08-${Date.now()}-${Math.random()}@test.local`,
        passwordHash: 'x',
        kycStatus: 'VERIFIED',
        countryCode: 'NG',
        eligibility: {
          create: { countryCode: 'NG', countryAllowed: true, ageVerified: true }
        }
      }
    });
    const wallet = await prisma.wallet.create({
      data: { userId: user.id }
    });
    userId = user.id;
    walletId = wallet.id;
  };

  const intentCount = async (status) =>
    prisma.depositIntent.count({ where: { userId, ...(status ? { status } : {}) } });

  const balance = async () => {
    const bal = await availableBalance();
    return (bal.PLAYER_AVAILABLE ?? 0n).toString();
  };

  const ledgerCreditKey = (reference) => `deposit:credit:${reference}`;

  const ledgerCreditCount = async (reference) =>
    prisma.ledgerTransaction.count({
      where: { idempotencyKey: ledgerCreditKey(reference) }
    });

  const availableBalance = async () => {
    const accounts = ['PLAYER_AVAILABLE', 'CUSTOMER_LIABILITY'];
    const row = await prisma.ledgerAccount.findMany({
      where: { OR: [{ userId, type: 'PLAYER_AVAILABLE' }, { userId: null, type: 'CUSTOMER_LIABILITY' }], currency: 'NGN' },
      include: { entries: true }
    });
    const bal = {};
    for (const a of row) bal[a.type] = a.entries.reduce((acc, e) => acc + e.amountMinorUnits, 0n);
    return bal;
  };

  const outboxCount = async () =>
    prisma.outboxEvent.count({
      where: { aggregateId: walletId, eventType: 'wallet.updated' }
    });

  const notificationCount = async () =>
    prisma.notification.count({ where: { userId, type: 'DEPOSIT_CONFIRMED' } });

  const cleanup = async () => {
    const intents = await prisma.depositIntent.findMany({
      where: { userId },
      select: { id: true }
    });
    const intentIds = intents.map((i) => i.id);
    for (const id of intentIds) {
      await prisma.ledgerEntry.deleteMany({
        where: { transaction: { metadata: { path: ['depositIntentId'], equals: id } } }
      });
      await prisma.ledgerTransaction.deleteMany({
        where: { metadata: { path: ['depositIntentId'], equals: id } }
      });
    }
    await prisma.outboxEvent.deleteMany({ where: { aggregateId: walletId } });
    await prisma.notification.deleteMany({ where: { userId } });
    await prisma.depositIntent.deleteMany({ where: { userId } });
    await prisma.wallet.delete({ where: { id: walletId } });
    await prisma.user.delete({ where: { id: userId } });
  };

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('credits exactly the stored intent amount and marks the intent applied', async () => {
    await createFixture();
    const intent = await createDepositIntent(userId, 50000n, 'PAYSTACK', 'u@test.local');

    // CUSTOMER_LIABILITY is a persistent system singleton carrying history from
    // every other suite/run, so assert its DELTA, never an absolute balance.
    const prevLiability = prisma.ledgerEntry.aggregate({
      where: { account: { type: 'CUSTOMER_LIABILITY' } },
      _sum: { amountMinorUnits: true }
    }).then((a) => a._sum.amountMinorUnits ?? 0n);

    const result = await processDepositWebhook({
      reference: intent.reference,
      amountMinorUnits: 50000,
      currency: 'NGN',
      gateway: 'PAYSTACK',
      userId
    });

    expect(result.handled).toBe(true);
    expect(result.alreadyApplied).toBe(false);
    expect(await balance()).toBe('50000');

    const stored = await prisma.depositIntent.findUnique({ where: { id: intent.id } });
    expect(stored.status).toBe('COMPLETED');
    expect(stored.appliedAt).not.toBeNull();

    // The deposit posts a balanced DEPOSIT_CREDIT in the same transaction —
    // PLAYER_AVAILABLE +amount, CUSTOMER_LIABILITY -amount.
    expect(await ledgerCreditCount(intent.reference)).toBe(1);
    const ledgerBal = await availableBalance();
    expect(ledgerBal.PLAYER_AVAILABLE).toBe(50000n);
    expect(ledgerBal.CUSTOMER_LIABILITY - (await prevLiability)).toBe(-50000n);
    // Durable wallet.updated outbox row + notification, atomic with the credit.
    expect(await outboxCount()).toBe(1);
    expect(await notificationCount()).toBe(1);

    await cleanup();
  });

  it('rejects a webhook amount different from the stored intent, crediting nothing', async () => {
    await createFixture();
    const intent = await createDepositIntent(userId, 50000n, 'PAYSTACK', 'u@test.local');

    const result = await processDepositWebhook({
      reference: intent.reference,
      amountMinorUnits: 999999,
      currency: 'NGN',
      gateway: 'PAYSTACK',
      userId
    });

    expect(result).toMatchObject({ handled: false, reason: 'AMOUNT_MISMATCH' });
    expect(await balance()).toBe('0');
    expect(await ledgerCreditCount(intent.reference)).toBe(0);
    expect(await intentCount('PENDING')).toBe(1);

    await cleanup();
  });

  it('rejects a webhook claiming a different user than the stored intent', async () => {
    await createFixture();
    const intent = await createDepositIntent(userId, 50000n, 'PAYSTACK', 'u@test.local');

    const result = await processDepositWebhook({
      reference: intent.reference,
      amountMinorUnits: 50000,
      currency: 'NGN',
      gateway: 'PAYSTACK',
      userId: 'some-other-user'
    });

    expect(result).toMatchObject({ handled: false, reason: 'USER_MISMATCH' });
    expect(await balance()).toBe('0');

    await cleanup();
  });

  it('rejects a webhook with a non-matching currency', async () => {
    await createFixture();
    const intent = await createDepositIntent(userId, 50000n, 'PAYSTACK', 'u@test.local');

    const result = await processDepositWebhook({
      reference: intent.reference,
      amountMinorUnits: 50000,
      currency: 'USD',
      gateway: 'PAYSTACK',
      userId
    });

    expect(result).toMatchObject({ handled: false, reason: 'CURRENCY_MISMATCH' });
    expect(await balance()).toBe('0');

    await cleanup();
  });

  it('rejects an unknown reference', async () => {
    await createFixture();

    const result = await processDepositWebhook({
      reference: 'paystack-never-created',
      amountMinorUnits: 50000,
      currency: 'NGN',
      gateway: 'PAYSTACK',
      userId
    });

    expect(result).toMatchObject({ handled: false, reason: 'UNKNOWN_REFERENCE' });
    expect(await balance()).toBe('0');
    expect(await intentCount()).toBe(0);

    await cleanup();
  });

  it('replays a duplicate delivery once and does not re-credit', async () => {
    await createFixture();
    const intent = await createDepositIntent(userId, 50000n, 'PAYSTACK', 'u@test.local');
    const webhook = {
      reference: intent.reference,
      amountMinorUnits: 50000,
      currency: 'NGN',
      gateway: 'PAYSTACK',
      userId
    };

    const first = await processDepositWebhook(webhook);
    const second = await processDepositWebhook(webhook);

    expect(first.handled).toBe(true);
    expect(second.handled).toBe(false);
    expect(second.alreadyApplied).toBe(true);
    expect(await balance()).toBe('50000');
    // Exactly-once everywhere: one ledger posting, one outbox row, one notice.
    expect(await ledgerCreditCount(intent.reference)).toBe(1);
    expect(await outboxCount()).toBe(1);
    expect(await notificationCount()).toBe(1);

    await cleanup();
  });

  it('keeps a concurrent double delivery to exactly one credit everywhere', async () => {
    await createFixture();
    const intent = await createDepositIntent(userId, 50000n, 'PAYSTACK', 'u@test.local');
    const webhook = {
      reference: intent.reference,
      amountMinorUnits: 50000,
      currency: 'NGN',
      gateway: 'PAYSTACK',
      userId
    };

    const results = await Promise.all([
      processDepositWebhook(webhook),
      processDepositWebhook(webhook)
    ]);

    const applied = results.filter((r) => r.handled && !r.alreadyApplied);
    const duplicates = results.filter((r) => r.alreadyApplied);
    expect(applied).toHaveLength(1);
    expect(duplicates).toHaveLength(1);
    expect(await balance()).toBe('50000');
    expect(await ledgerCreditCount(intent.reference)).toBe(1);
    expect(await outboxCount()).toBe(1);
    expect(await notificationCount()).toBe(1);

    await cleanup();
  });

  it('parks stale PENDING intents as FAILED and still credits a late valid webhook exactly once', async () => {
    await createFixture();
    const intent = await createDepositIntent(userId, 50000n, 'PAYSTACK', 'u@test.local');
    // Backdate well past the 24h stale threshold so the sweep treats it as a
    // payment that never arrived.
    await prisma.depositIntent.update({
      where: { id: intent.id },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }
    });

    const summary = await reconcileDeposits();
    expect(summary.staleParked).toBeGreaterThanOrEqual(1);

    const parked = await prisma.depositIntent.findUnique({ where: { id: intent.id } });
    expect(parked.status).toBe('FAILED');
    expect(await balance()).toBe('0');
    expect(await ledgerCreditCount(intent.reference)).toBe(0);

    // A provider webhook that arrives LATE must still credit once: the guard
    // against double-application is the intent-status CAS, not a clock.
    const late = await processDepositWebhook({
      reference: intent.reference,
      amountMinorUnits: 50000,
      currency: 'NGN',
      gateway: 'PAYSTACK',
      userId
    });
    expect(late.handled).toBe(true);

    const applied = await prisma.depositIntent.findUnique({ where: { id: intent.id } });
    expect(applied.status).toBe('COMPLETED');
    expect(await balance()).toBe('50000');
    expect(await ledgerCreditCount(intent.reference)).toBe(1);
    expect(await outboxCount()).toBe(1);
    expect(await notificationCount()).toBe(1);

    // Re-running the sweep after the late credit is healthy: the intent is
    // COMPLETED with exactly one credit everywhere.
    const after = await reconcileDeposits();
    expect(after.anomalies).toEqual([]);

    await cleanup();
  });

  it('reconciliation flags a COMPLETED intent whose ledger posting is missing and never repairs it', async () => {
    await createFixture();
    const intent = await createDepositIntent(userId, 50000n, 'PAYSTACK', 'u@test.local');
    await processDepositWebhook({
      reference: intent.reference,
      amountMinorUnits: 50000,
      currency: 'NGN',
      gateway: 'PAYSTACK',
      userId
    });
    expect(await ledgerCreditCount(intent.reference)).toBe(1);

    // Simulate the anomaly the sweep must catch: a confirmed deposit whose
    // ledger posting vanished (entries cascade with the transaction).
    await prisma.ledgerTransaction.deleteMany({
      where: { idempotencyKey: ledgerCreditKey(intent.reference) }
    });

    const summary = await reconcileDeposits();
    expect(summary.anomalies.some((a) => a.check === 'ledgerPostingMissing')).toBe(true);
    // Never auto-repair: the posting stays gone after the sweep.
    expect(await ledgerCreditCount(intent.reference)).toBe(0);

    await cleanup();
  });

  it('rejects a Flutterwave gateway event against a Paystack intent', async () => {
    await createFixture();
    const intent = await createDepositIntent(userId, 50000n, 'PAYSTACK', 'u@test.local');

    const result = await processDepositWebhook({
      reference: intent.reference,
      amountMinorUnits: 50000,
      currency: 'NGN',
      gateway: 'FLUTTERWAVE',
      userId
    });

    expect(result).toMatchObject({ handled: false, reason: 'GATEWAY_MISMATCH' });
    expect(await balance()).toBe('0');

    await cleanup();
  });

  it('credits only the stored intent amount when equality holds (webhook amount is never the source of truth)', async () => {
    await createFixture();
    // Intent for 250.00 NGN
    const intent = await createDepositIntent(userId, 25000n, 'FLUTTERWAVE', 'u@test.local');

    // Flutterwave sends major units; even a "close but not equal" float like
    // 250.01 must be rejected because 250000 !== 25001 in minor units.
    const result = await processDepositWebhook({
      reference: intent.reference,
      amountMinorUnits: 25001,
      currency: 'NGN',
      gateway: 'FLUTTERWAVE',
      userId
    });

    expect(result).toMatchObject({ handled: false, reason: 'AMOUNT_MISMATCH' });
    expect(await balance()).toBe('0');
    await cleanup();
  });
});