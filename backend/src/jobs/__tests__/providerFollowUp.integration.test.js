// Real-PostgreSQL integration test for the provider payout follow-up sweep:
// a PROCESSING withdrawal that never got a webhook is resolved from the
// provider's authoritative verdict. Run against a scratch Postgres:
//   DATABASE_URL=postgresql://test:test@127.0.0.1:5544/draughts_arena_test?schema=public \
//   REDIS_URL= RUN_DB_INTEGRATION=1 node --experimental-vm-modules node_modules/jest/bin/jest.js \
//     src/jobs/__tests__/providerFollowUp.integration.test.js
import crypto from 'crypto';
import prisma from '../../utils/db.js';
import { WithdrawalService } from '../../modules/withdrawal/service.js';
import { createDepositIntent, processDepositWebhook } from '../../modules/wallet/service.js';
import { processProviderFollowUp } from '../providerFollowUp.js';

const describeIntegration =
  process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

describeIntegration('Provider payout follow-up (real PostgreSQL)', () => {
  let userId;
  let walletId;
  let bankAccountId;
  const depositRefs = [];
  const withdrawalIds = [];
  const reference = `followup-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const fakeProvider = (verifyStatus) => ({
  resolveBankAccount: async () => ({ accountName: 'Jane Doe' }),
  createRecipient: async () => ({ recipientRef: 'RCP-fake' }),
  initiatePayout: async () => ({ providerRef: `prov-${crypto.randomUUID()}` }),
  verifyPayoutStatus: verifyStatus
});

  const makeService = (verifyStatus) =>
    new WithdrawalService({ providers: { PAYSTACK: fakeProvider(verifyStatus) } });

  const createFixture = async () => {
    const user = await prisma.user.create({
      data: {
        email: `followup-${Date.now()}-${Math.random()}@test.local`,
        passwordHash: 'x',
        kycStatus: 'VERIFIED',
        countryCode: 'NG',
        eligibility: {
          create: { countryCode: 'NG', countryAllowed: true, ageVerified: true }
        }
      }
    });
    const wallet = await prisma.wallet.create({ data: { userId: user.id } });
    const bankAccount = await prisma.bankAccount.create({
      data: {
        userId: user.id,
        gateway: 'PAYSTACK',
        bankCode: '057',
        bankName: 'Zenith',
        accountNumber: '0123456789',
        accountName: 'Jane Doe',
        verifiedName: 'Jane Doe',
        recipientRef: 'RCP-fake',
        verifiedAt: new Date()
      }
    });
    userId = user.id;
    walletId = wallet.id;
    bankAccountId = bankAccount.id;
  };

  // Funds a user the real way (verified stored intent + ledger credit) so the
  // withdrawal reserve/complete money path is real.
  const fundUser = async (amountMinorUnits) => {
    const intent = await createDepositIntent(userId, amountMinorUnits, 'PAYSTACK');
    depositRefs.push(intent.reference);
    await processDepositWebhook({
      reference: intent.reference,
      amountMinorUnits,
      currency: 'NGN',
      gateway: 'PAYSTACK',
      userId
    });
  };

  // Drives a withdrawal to PROCESSING (reserve + approval + provider init).
  const toProcessing = async (service, amountMinorUnits) => {
    const requested = await service.requestWithdrawal(userId, amountMinorUnits, undefined, bankAccountId);
    withdrawalIds.push(requested.id);
    await service.approveWithdrawal(requested.id, 'admin-1');
    return service.beginPayout(requested.id);
  };

  // Every suite shares one CUSTOMER_LIABILITY account, so the fixture money
  // must be fully unwound here: deleting the deposit/reserve/complete postings
  // cascades their entries (liability back to 0) before the domain rows go.
  afterEach(async () => {
    const keys = [];
    for (const id of withdrawalIds) {
      keys.push(`withdrawal:complete:${id}`, `withdrawal:reserve:${id}`, `withdrawal:release:${id}`);
    }
    for (const depRef of depositRefs) keys.push(`deposit:credit:${depRef}`);
    await prisma.ledgerTransaction.deleteMany({ where: { idempotencyKey: { in: keys } } });
    await prisma.withdrawal.deleteMany({ where: { id: { in: withdrawalIds } } });
    await prisma.outboxEvent.deleteMany({ where: { aggregateId: walletId } });
    await prisma.notification.deleteMany({ where: { userId } });
    await prisma.depositIntent.deleteMany({ where: { userId } });
    await prisma.bankAccount.deleteMany({ where: { id: bankAccountId } });
    await prisma.wallet.deleteMany({ where: { id: walletId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    withdrawalIds.length = 0;
    depositRefs.length = 0;
  });

  const vault = async () => {
    const accounts = await prisma.ledgerAccount.findMany({
      where: { OR: [{ userId }, { type: 'CUSTOMER_LIABILITY' }], currency: 'NGN' },
      include: { entries: true }
    });
    const byType = {};
    for (const a of accounts) {
      byType[a.type] = (byType[a.type] ?? 0n) + a.entries.reduce((acc, e) => acc + e.amountMinorUnits, 0n);
    }
    return byType;
  };

  beforeEach(async () => {
    await createFixture();
    await fundUser(200_000);
  });

  it('resolves a stale PROCESSING payout on a provider success verdict, exactly once', async () => {
    const amount = 100_000;
    const service = makeService(async () => ({ status: 'success' }));
    const { id } = await toProcessing(service, amount);

    // let it age past the sweep threshold
    await prisma.withdrawal.updateMany({
      where: { id },
      data: { processedAt: new Date(Date.now() - 7 * 60 * 60 * 1000) }
    });

    const result = await processProviderFollowUp({ service, ageHours: 6 });

    expect(result).toMatchObject({ scanned: 1, checked: 1, resolved: 1, pending: 0 });

    const [row] = await prisma.withdrawal.findMany({ where: { id } });
    expect(row.status).toBe('COMPLETED');

    // WITHDRAWAL_CONFIRMED posting: pending funds moved to liability
    const complete = await prisma.ledgerTransaction.findUnique({
      where: { idempotencyKey: `withdrawal:complete:${id}` }
    });
    expect(complete).not.toBeNull();

    // next sweep has nothing to do: the row is terminal
    const again = await processProviderFollowUp({ service, ageHours: 1 });
    expect(again.scanned).toBe(0);
  });

  it('marks a stale payout FAILED on a provider failure verdict (funds stay reserved)', async () => {
    const amount = 100_000;
    const service = makeService(async () => ({ status: 'failed' }));
    const { id } = await toProcessing(service, amount);

    await prisma.withdrawal.updateMany({
      where: { id },
      data: { processedAt: new Date(Date.now() - 7 * 60 * 60 * 1000) }
    });

    const result = await processProviderFollowUp({ service, ageHours: 6 });

    expect(result.resolved).toBe(1);
    const [row] = await prisma.withdrawal.findMany({ where: { id } });
    expect(row.status).toBe('FAILED');
    expect(row.failureReason).toMatch(/follow-up sweep/i);

    // no release/complete terminal posting before the operator decides
    const completion = await prisma.ledgerTransaction.findUnique({
      where: { idempotencyKey: `withdrawal:complete:${id}` }
    });
    expect(completion).toBeNull();
  });

  it('does not move money on an ambiguous verdict — records the check and re-probes later', async () => {
    const amount = 100_000;
    const service = makeService(async () => ({ status: 'processing' }));
    const { id } = await toProcessing(service, amount);

    await prisma.withdrawal.updateMany({
      where: { id },
      data: { processedAt: new Date(Date.now() - 7 * 60 * 60 * 1000) }
    });

    const first = await processProviderFollowUp({ service, ageHours: 6 });
    expect(first).toMatchObject({ scanned: 1, pending: 1, resolved: 0 });

    const [row] = await prisma.withdrawal.findMany({ where: { id } });
    expect(row.status).toBe('PROCESSING');
    expect(row.followUpCheckAt).not.toBeNull();

    // the just-recorded check suppresses a second probe (recheck interval 30m)
    const second = await processProviderFollowUp({ service, ageHours: 6 });
    expect(second.scanned).toBe(0);
  });
});