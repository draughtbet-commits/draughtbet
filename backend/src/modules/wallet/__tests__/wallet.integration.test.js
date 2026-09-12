// Real-PostgreSQL S01 integration test. The default suite runs with no DB
// (skipped); run it against a scratch Postgres with migrations applied:
//   DATABASE_URL=postgresql://test:test@127.0.0.1:5544/draughts_arena_test?schema=public \
//   REDIS_URL= RUN_DB_INTEGRATION=1 node --experimental-vm-modules node_modules/jest/bin/jest.js \
//     src/modules/wallet/__tests__/wallet.integration.test.js
import prisma from '../../../utils/db.js';
import { requestWithdrawal } from '../service.js';

const describeIntegration =
  process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

describeIntegration('Wallet S01 (real PostgreSQL concurrency)', () => {
  let userId;
  let walletId;

  const createFixture = async (balance) => {
    const user = await prisma.user.create({
      data: { email: `s01-${Date.now()}-${Math.random()}@test.local`, passwordHash: 'x' }
    });
    const wallet = await prisma.wallet.create({
      data: { userId: user.id, balanceMinorUnits: balance }
    });
    userId = user.id;
    walletId = wallet.id;
  };

  const cleanup = async () => {
    await prisma.withdrawalRequest.deleteMany({ where: { userId } });
    await prisma.walletTransaction.deleteMany({ where: { walletId } });
    await prisma.wallet.delete({ where: { id: walletId } });
    await prisma.user.delete({ where: { id: userId } });
  };

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('serializes concurrent withdrawals: 2x80 on a 100 balance -> exactly one succeeds, balance 20', async () => {
    await createFixture(100n);

    const results = await Promise.allSettled([
      requestWithdrawal(userId, 80n, 'op_conc_a'),
      requestWithdrawal(userId, 80n, 'op_conc_b')
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.message).toMatch(/Insufficient funds/i);

    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    expect(wallet.balanceMinorUnits.toString()).toBe('20');

    const requests = await prisma.withdrawalRequest.count({ where: { userId } });
    const txns = await prisma.walletTransaction.count({
      where: { walletId, type: 'WITHDRAWAL' }
    });
    expect(requests).toBe(1);
    expect(txns).toBe(1);

    await cleanup();
  });

  it('replays with the same idempotencyKey debit once and returns the original request', async () => {
    await createFixture(100n);

    const [a, b] = await Promise.all([
      requestWithdrawal(userId, 80n, 'op_replay_key'),
      requestWithdrawal(userId, 80n, 'op_replay_key')
    ]);
    expect(a.id).toBe(b.id);

    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    expect(wallet.balanceMinorUnits.toString()).toBe('20');

    const requests = await prisma.withdrawalRequest.count({ where: { userId } });
    const txns = await prisma.walletTransaction.count({
      where: { walletId, type: 'WITHDRAWAL' }
    });
    expect(requests).toBe(1);
    expect(txns).toBe(1);

    await cleanup();
  });

  it('same idempotencyKey with a different amount returns the original request untouched', async () => {
    await createFixture(100n);

    const first = await requestWithdrawal(userId, 30n, 'op_amount_key');
    const replay = await requestWithdrawal(userId, 90n, 'op_amount_key');

    expect(replay.id).toBe(first.id);
    expect(replay.amountMinorUnits.toString()).toBe('30');

    const wallet = await prisma.wallet.findUnique({ where: { userId } });
    expect(wallet.balanceMinorUnits.toString()).toBe('70');

    await cleanup();
  });
});