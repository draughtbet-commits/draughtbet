// Real-PostgreSQL integration test for WithdrawalService. Run with:
//   DATABASE_URL=... RUN_DB_INTEGRATION=1 node --experimental-vm-modules node_modules/jest/bin/jest.js \
//     --runInBand --forceExit --no-coverage src/modules/withdrawal/__tests__/withdrawal.integration.test.js
import { describe, it, expect, afterAll, jest } from '@jest/globals';
import prisma from '../../../utils/db.js';
import { ensureSystemAccount } from '../../../services/ledgerService.js';
import { WithdrawalService } from '../service.js';

const describeIntegration =
  process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

const service = () =>
  new WithdrawalService({
    providers: {
      PAYSTACK: {
        initiatePayout: jest.fn().mockResolvedValue({ providerRef: 'TXN_fake_paystack' })
      }
    }
  });

const sumAccount = async (userId, type, system = false) => {
  const accounts = await prisma.ledgerAccount.findMany({
    where: system ? { type } : { userId, type }
  });
  if (accounts.length === 0) return 0n;
  const sum = await prisma.ledgerEntry.aggregate({
    where: { accountId: { in: accounts.map((a) => a.id) } },
    _sum: { amountMinorUnits: true }
  });
  return sum._sum.amountMinorUnits ?? 0n;
};

describeIntegration('Withdrawal V2 (real PostgreSQL concurrency + lifecycle)', () => {
  let userId;
  let walletId;

  const seedDeposit = async (uId, amount) => {
    const liability = await ensureSystemAccount(prisma, 'CUSTOMER_LIABILITY', 'NGN');
    const available = await prisma.ledgerAccount.create({
      data: { userId: uId, type: 'PLAYER_AVAILABLE', currency: 'NGN' }
    });
    const txn = await prisma.ledgerTransaction.create({
      data: { type: 'DEPOSIT_CREDIT', idempotencyKey: `withdrawal:test:seed:${uId}` }
    });
    await prisma.ledgerEntry.create({ data: { transactionId: txn.id, accountId: available.id, amountMinorUnits: amount } });
    await prisma.ledgerEntry.create({ data: { transactionId: txn.id, accountId: liability.id, amountMinorUnits: -amount } });
    return available;
  };

  const addVerifiedBank = async (uId) => {
    return prisma.bankAccount.create({
      data: {
        userId: uId,
        gateway: 'PAYSTACK',
        bankCode: '057',
        bankName: 'Zenith',
        accountNumber: `0123${String(uId).slice(0, 6)}`,
        accountName: 'Test Player',
        recipientRef: `RCP_${uId}`,
        verifiedName: 'Test Player',
        isDefault: true,
        verifiedAt: new Date()
      }
    });
  };

  const createFixture = async (balance, { withBank = true } = {}) => {
    const user = await prisma.user.create({
      data: {
        email: `wd-${Date.now()}-${Math.random()}@test.local`,
        passwordHash: 'x',
        kycStatus: 'VERIFIED',
        countryCode: 'NG',
        eligibility: {
          create: { countryCode: 'NG', countryAllowed: true, ageVerified: true }
        }
      }
    });
    const wallet = await prisma.wallet.create({ data: { userId: user.id } });
    await seedDeposit(user.id, balance);
    if (withBank) await addVerifiedBank(user.id);
    userId = user.id;
    walletId = wallet.id;
  };

  const cleanup = async () => {
    await prisma.withdrawal.deleteMany({ where: { userId } });
    await prisma.bankAccount.deleteMany({ where: { userId } });
    await prisma.outboxEvent.deleteMany({ where: { aggregateId: walletId, eventType: 'wallet.updated' } });
    await prisma.notification.deleteMany({ where: { userId } });
    await prisma.ledgerTransaction.deleteMany({
      where: { OR: [{ idempotencyKey: { startsWith: 'withdrawal:' } }] }
    });
    await prisma.wallet.delete({ where: { id: walletId } });
    await prisma.user.delete({ where: { id: userId } });
  };

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('serializes concurrent withdrawals: 2x80 on a 100 balance -> exactly one succeeds, balance 20', async () => {
    await createFixture(100n);

    const results = await Promise.allSettled([
      service().requestWithdrawal(userId, 80n, 'op_conc_a'),
      service().requestWithdrawal(userId, 80n, 'op_conc_b')
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.message).toMatch(/Insufficient funds/i);

    // Ledger drives the balance: exactly 80 moved to PLAYER_WITHDRAWAL_PENDING.
    expect(await sumAccount(userId, 'PLAYER_AVAILABLE')).toBe(20n);
    expect(await sumAccount(userId, 'PLAYER_WITHDRAWAL_PENDING')).toBe(80n);

    const withdrawals = await prisma.withdrawal.count({ where: { userId } });
    expect(withdrawals).toBe(1);
    // Scope the ledger count to this user's accounts: the shared DB carries a
    // withdrawal history from other suites/owners that must not count here.
    const accounts = await prisma.ledgerAccount.findMany({
      where: { userId },
      select: { id: true }
    });
    const reserves = await prisma.ledgerTransaction.count({
      where: {
        idempotencyKey: { startsWith: 'withdrawal:reserve:' },
        entries: { some: { accountId: { in: accounts.map((a) => a.id) } } }
      }
    });
    expect(reserves).toBe(1);

    await cleanup();
  });

  it('replays with the same idempotencyKey: debits once and returns the original request', async () => {
    await createFixture(100n);

    const [a, b] = await Promise.all([
      service().requestWithdrawal(userId, 80n, 'op_replay_key'),
      service().requestWithdrawal(userId, 80n, 'op_replay_key')
    ]);
    expect(a.id).toBe(b.id);

    expect(await sumAccount(userId, 'PLAYER_AVAILABLE')).toBe(20n);
    expect(await sumAccount(userId, 'PLAYER_WITHDRAWAL_PENDING')).toBe(80n);

    const withdrawals = await prisma.withdrawal.count({ where: { userId } });
    expect(withdrawals).toBe(1);

    await cleanup();
  });

  it('same idempotencyKey with a different amount returns the original request untouched', async () => {
    await createFixture(100n);

    const first = await service().requestWithdrawal(userId, 30n, 'op_amount_key');
    const replay = await service().requestWithdrawal(userId, 90n, 'op_amount_key');

    expect(replay.id).toBe(first.id);
    expect(replay.amountMinorUnits).toBe('30');

    expect(await sumAccount(userId, 'PLAYER_AVAILABLE')).toBe(70n);

    await cleanup();
  });

  it('blocks withdrawal for an account without KYC even with funds available', async () => {
    await createFixture(100n);
    await prisma.user.update({ where: { id: userId }, data: { kycStatus: 'NONE' } });

    await expect(service().requestWithdrawal(userId, 80n, 'op_no_kyc'))
      .rejects.toThrow('KYC verification is required');

    expect(await sumAccount(userId, 'PLAYER_AVAILABLE')).toBe(100n);

    const withdrawals = await prisma.withdrawal.count({ where: { userId } });
    expect(withdrawals).toBe(0);

    await cleanup();
  });

  it('requires a provider-verified payout destination', async () => {
    await createFixture(100n, { withBank: false });

    await expect(service().requestWithdrawal(userId, 10n, 'op_no_bank'))
      .rejects.toThrow(/verified bank account is required/);

    expect(await sumAccount(userId, 'PLAYER_AVAILABLE')).toBe(100n);
    expect(await prisma.withdrawal.count({ where: { userId } })).toBe(0);

    await cleanup();
  });

  it('withdrawal overlapping a stake debit never reserves more than available funds', async () => {
    await createFixture(100n);

    const friend = await prisma.user.create({
      data: {
        email: `wd-stake-${Date.now()}-${Math.random()}@test.local`,
        passwordHash: 'x',
        kycStatus: 'VERIFIED',
        countryCode: 'NG',
        eligibility: {
          create: { countryCode: 'NG', countryAllowed: true, ageVerified: true }
        }
      }
    });
    await prisma.wallet.create({ data: { userId: friend.id } });
    await seedDeposit(friend.id, 100000n);
    await prisma.platformSettings.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', commissionPercent: 10 },
      update: { commissionPercent: 10 }
    });
    const { debitStakes } = await import('../../../services/matchService.js');

    const results = await Promise.allSettled([
      service().requestWithdrawal(userId, 80n, 'op_stake_race_a'),
      debitStakes(userId, friend.id, 80n, 'AMATEUR')
    ]);

    const rejected = results.filter(r => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.message).toMatch(/Insufficient funds/i);

    expect(await sumAccount(userId, 'PLAYER_AVAILABLE')).toBe(20n);

    const withdrawals = await prisma.withdrawal.count({ where: { userId } });
    const matches = await prisma.match.count({
      where: { OR: [{ playerLightId: userId }, { playerDarkId: userId }] }
    });
    expect(withdrawals + matches).toBe(1);

    const match = await prisma.match.findFirst({
      where: { OR: [{ playerLightId: userId }, { playerDarkId: userId }] }
    });
    if (match) {
      await prisma.ledgerTransaction.deleteMany({ where: { relatedMatchId: match.id } });
      await prisma.match.delete({ where: { id: match.id } });
    }
    const friendAccounts = await prisma.ledgerAccount.findMany({
      where: { userId: friend.id },
      select: { id: true }
    });
    await prisma.ledgerEntry.deleteMany({
      where: { accountId: { in: friendAccounts.map((a) => a.id) } }
    });
    await prisma.ledgerTransaction.deleteMany({
      where: { idempotencyKey: `withdrawal:test:seed:${friend.id}` }
    });
    await prisma.ledgerAccount.deleteMany({ where: { userId: friend.id } });
    await prisma.wallet.delete({ where: { userId: friend.id } });
    await prisma.user.delete({ where: { id: friend.id } });
    await cleanup();
  });

  it('payout callback completes once even when delivered twice; liability returns to 0', async () => {
    await createFixture(100000n);
    const svc = service();

    const reserved = await svc.requestWithdrawal(userId, 100000n, 'op_lifecycle');
    await svc.approveWithdrawal(reserved.id, 'admin-1');
    const processing = await svc.beginPayout(reserved.id);
    expect(processing.status).toBe('PROCESSING');
    expect(processing.providerRef).toBe('TXN_fake_paystack');

    const callback = (eventType) =>
      svc.handlePayoutCallback({ gateway: 'PAYSTACK', eventType, data: { reference: reserved.reference } });

    const first = await callback('transfer.success');
    expect(first.handled).toBe(true);
    const second = await callback('transfer.success');
    expect(second.handled).toBe(true);

    const w = await prisma.withdrawal.findUnique({ where: { id: reserved.id } });
    expect(w.status).toBe('COMPLETED');

    // Funds were moved exactly once: pending back to 0, available 0,
    // liability delta applied once.
    expect(await sumAccount(userId, 'PLAYER_WITHDRAWAL_PENDING')).toBe(0n);
    expect(await sumAccount(userId, 'PLAYER_AVAILABLE')).toBe(0n);
    expect(await sumAccount(userId, 'CUSTOMER_LIABILITY', true)).toBe(0n);

    const confirmations = await prisma.notification.count({
      where: { userId, type: 'WITHDRAWAL_CONFIRMED' }
    });
    expect(confirmations).toBe(1);

    const completePostings = await prisma.ledgerTransaction.count({
      where: { idempotencyKey: { startsWith: 'withdrawal:complete:' } }
    });
    expect(completePostings).toBe(1);

    await cleanup();
  });

  it('failed payout keeps funds reserved; admin release refunds exactly once, release is idempotent', async () => {
    await createFixture(100000n);
    const svc = new WithdrawalService({
      providers: {
        PAYSTACK: { initiatePayout: jest.fn().mockRejectedValue(new Error('provider rejected')) }
      }
    });

    const reserved = await svc.requestWithdrawal(userId, 100000n, 'op_fail_flow');
    await svc.approveWithdrawal(reserved.id, 'admin-1');
    const failed = await svc.beginPayout(reserved.id);
    expect(failed.status).toBe('FAILED');
    expect(failed.failureReason).toBe('provider rejected');

    // Funds still reserved — nothing returned yet.
    expect(await sumAccount(userId, 'PLAYER_WITHDRAWAL_PENDING')).toBe(100000n);

    await svc.releaseWithdrawal(failed.id, { failureReason: 'not retrying', adminId: 'admin-1' });
    // Releasing again is a no-op.
    await svc.releaseWithdrawal(failed.id, { failureReason: 'still not retrying' });

    expect(await sumAccount(userId, 'PLAYER_AVAILABLE')).toBe(100000n);

    const refunds = await prisma.ledgerTransaction.count({
      where: { idempotencyKey: { startsWith: 'withdrawal:release:' } }
    });
    expect(refunds).toBe(1);

    expect(await sumAccount(userId, 'PLAYER_WITHDRAWAL_PENDING')).toBe(0n);
    expect(await sumAccount(userId, 'PLAYER_AVAILABLE')).toBe(100000n);
    expect(await sumAccount(userId, 'CUSTOMER_LIABILITY', true)).toBe(-100000n);

    const refundNotices = await prisma.notification.count({
      where: { userId, type: 'WITHDRAWAL_REFUNDED' }
    });
    expect(refundNotices).toBe(1);

    await cleanup();
  });
});