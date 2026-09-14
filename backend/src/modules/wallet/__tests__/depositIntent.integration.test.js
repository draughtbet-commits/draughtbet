// Real-PostgreSQL integration test for the S08 payment-intent fix. The
// default suite runs with no DB (skipped); run it against a scratch Postgres
// with migrations applied:
//   DATABASE_URL=postgresql://test:test@127.0.0.1:5544/draughts_arena_test?schema=public \
//   REDIS_URL= RUN_DB_INTEGRATION=1 node --experimental-vm-modules node_modules/jest/bin/jest.js \
//     src/modules/wallet/__tests__/depositIntent.integration.test.js
import prisma from '../../../utils/db.js';
import { createDepositIntent, processDepositWebhook } from '../service.js';

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
      data: { userId: user.id, balanceMinorUnits: 0n }
    });
    userId = user.id;
    walletId = wallet.id;
  };

  const intentCount = async (status) =>
    prisma.depositIntent.count({ where: { userId, ...(status ? { status } : {}) } });

  const balance = async () => {
    const w = await prisma.wallet.findUnique({ where: { userId } });
    return w.balanceMinorUnits.toString();
  };

  const txCount = async () =>
    prisma.walletTransaction.count({ where: { walletId, type: 'DEPOSIT' } });

  const cleanup = async () => {
    await prisma.walletTransaction.deleteMany({ where: { walletId } });
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
    expect(await txCount()).toBe(1);

    const stored = await prisma.depositIntent.findUnique({ where: { id: intent.id } });
    expect(stored.status).toBe('COMPLETED');
    expect(stored.appliedAt).not.toBeNull();

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
    expect(await txCount()).toBe(0);
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
    expect(await txCount()).toBe(1);

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