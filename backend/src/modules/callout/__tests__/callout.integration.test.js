// Real-PostgreSQL call-out integration test. Skipped by default; run:
//   DATABASE_URL=postgresql://test:test@127.0.0.1:5544/draughts_arena_test?schema=public \
//   REDIS_URL= RUN_DB_INTEGRATION=1 node --experimental-vm-modules node_modules/jest/bin/jest.js \
//     src/modules/callout/__tests__/callout.integration.test.js
import { jest } from '@jest/globals';

jest.unstable_mockModule('../../../sockets/gameManager.js', () => ({
  initializeGame: jest.fn()
}));

jest.unstable_mockModule('../../../sockets/index.js', () => ({
  getIO: jest.fn(() => ({ emit: jest.fn(), to: jest.fn(() => ({ emit: jest.fn() })) }))
}));

jest.unstable_mockModule('../../notification/service.js', () => ({
  NotificationService: { create: jest.fn() }
}));

const prisma = (await import('../../../utils/db.js')).default;
const { initializeGame } = await import('../../../sockets/gameManager.js');
const { acceptCallout } = await import('../service.js');

const describeIntegration =
  process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;

describeIntegration('Call-out acceptance policy (real PostgreSQL)', () => {
  const settings = { id: 'singleton', commissionPercent: 10 };
  const allUsers = [];
  const allMatches = [];
  const allCallouts = [];

  const makeUser = async (suffix, { tier = 'PRO', isBanned = false, balance = 10000000n } = {}) => {
    const user = await prisma.user.create({
      data: {
        email: `callout-${Date.now()}-${Math.random()}-${suffix}@test.local`,
        passwordHash: 'x',
        tier,
        isBanned,
        kycStatus: 'VERIFIED',
        countryCode: 'NG',
        eligibility: {
          create: { countryCode: 'NG', countryAllowed: true, ageVerified: true }
        }
      }
    });
    await prisma.wallet.create({ data: { userId: user.id, balanceMinorUnits: balance } });
    allUsers.push(user.id);
    return user;
  };

  const makeCallout = async (challengerId, stakeMinorUnits = 1000000n, tier = 'PRO') => {
    const callout = await prisma.callout.create({
      data: {
        challengerId,
        stakeMinorUnits,
        tier,
        status: 'OPEN',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000)
      }
    });
    allCallouts.push(callout.id);
    return callout;
  };

  const assertWallet = async (userId, expectedBalance) => {
    const w = await prisma.wallet.findUnique({ where: { userId } });
    expect(w.balanceMinorUnits.toString()).toBe(expectedBalance.toString());
  };

  const countLedger = async (matchId) =>
    prisma.walletTransaction.count({ where: { relatedMatchId: matchId } });

  beforeEach(async () => {
    await prisma.platformSettings.upsert({
      where: settings,
      create: settings,
      update: { commissionPercent: 10 }
    });
  });

  afterAll(async () => {
    for (const matchId of allMatches) {
      await prisma.matchMove.deleteMany({ where: { matchId } });
      await prisma.match.delete({ where: { id: matchId } });
    }
    await prisma.walletTransaction.deleteMany({
      where: { wallet: { userId: { in: allUsers } } }
    });
    await prisma.callout.deleteMany({ where: { id: { in: allCallouts } } });
    await prisma.wallet.deleteMany({ where: { userId: { in: allUsers } } });
    await prisma.user.deleteMany({ where: { id: { in: allUsers } } });
    await prisma.$disconnect();
  });

  it('accepts an eligible player: one match, two signed STAKE entries, callout ACCEPTED', async () => {
    const challenger = await makeUser('c');
    const acceptor = await makeUser('a');
    const callout = await makeCallout(challenger.id);

    const payload = await acceptCallout(acceptor.id, callout.id);
    allMatches.push(payload.id);

    expect(payload.tier).toBe('PRO');
    expect(payload.stakeMinorUnits.toString()).toBe('1000000');
    expect(payload.settlementCommissionPercent).toBe(10);

    const match = await prisma.match.findUnique({ where: { id: payload.id } });
    expect(match.playerLightId).toBe(challenger.id);
    expect(match.playerDarkId).toBe(acceptor.id);
    expect(match.status).toBe('ACTIVE');

    const claimed = await prisma.callout.findUnique({ where: { id: callout.id } });
    expect(claimed.status).toBe('ACCEPTED');
    expect(claimed.acceptedBy).toBe(acceptor.id);

    expect(await countLedger(payload.id)).toBe(2);
    for (const userId of [challenger.id, acceptor.id]) {
      await assertWallet(userId, 9000000n);
    }
    expect(initializeGame).toHaveBeenCalledWith(payload.id, challenger.id, acceptor.id, 'PRO');
  });

  it('rejects self-accept with zero side effects', async () => {
    const challenger = await makeUser('self');

    const callout = await makeCallout(challenger.id);

    await expect(acceptCallout(challenger.id, callout.id))
      .rejects.toThrow('Cannot accept your own callout');

    const claimed = await prisma.callout.findUnique({ where: { id: callout.id } });
    expect(claimed.status).toBe('OPEN');
    expect(claimed.acceptedBy).toBeNull();
    await assertWallet(challenger.id, 10000000n);
    expect(await prisma.match.count({ where: { OR: [{ playerLightId: challenger.id }, { playerDarkId: challenger.id }] } })).toBe(0);
  });

  it('concurrent accepts fund exactly once: one match, one claim, one set of STAKE entries', async () => {
    const challenger = await makeUser('race-c');
    const a1 = await makeUser('race-a1');
    const a2 = await makeUser('race-a2');
    const callout = await makeCallout(challenger.id);

    const [r1, r2] = await Promise.allSettled([
      acceptCallout(a1.id, callout.id),
      acceptCallout(a2.id, callout.id)
    ]);

    const resolved = [r1, r2].filter(r => r.status === 'fulfilled').map(r => r.value);
    const rejected = [r1, r2].filter(r => r.status === 'rejected');
    expect(resolved).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(Error);
    expect(rejected[0].reason.message).toBe('Callout is no longer available');

    allMatches.push(resolved[0].id);

    const claimed = await prisma.callout.findUnique({ where: { id: callout.id } });
    expect(claimed.status).toBe('ACCEPTED');
    expect([a1.id, a2.id]).toContain(claimed.acceptedBy);

    const funded = claimed.acceptedBy;
    const unfunded = funded === a1.id ? a2.id : a1.id;
    const match = await prisma.match.findUnique({ where: { id: resolved[0].id } });
    expect([match.playerLightId, match.playerDarkId].filter(p => p === funded)).toHaveLength(1);
    expect([match.playerLightId, match.playerDarkId]).not.toContain(unfunded);

    expect(await countLedger(resolved[0].id)).toBe(2);
    await assertWallet(funded, 9000000n);
    await assertWallet(unfunded, 10000000n);
  });

  it('rejects a banned challenger before any reservation', async () => {
    const challenger = await makeUser('banned-c', { isBanned: true });
    const acceptor = await makeUser('ok-a');
    const callout = await makeCallout(challenger.id);

    await expect(acceptCallout(acceptor.id, callout.id))
      .rejects.toThrow('Challenger is not eligible to play');

    const claimed = await prisma.callout.findUnique({ where: { id: callout.id } });
    expect(claimed.status).toBe('OPEN');
    await assertWallet(acceptor.id, 10000000n);
  });

  it('rejects a cross-tier accept', async () => {
    const challenger = await makeUser('pro-c');
    const amateur = await makeUser('ama-a', { tier: 'AMATEUR' });
    const callout = await makeCallout(challenger.id);

    await expect(acceptCallout(amateur.id, callout.id))
      .rejects.toThrow('Acceptor tier does not match the callout tier');

    const claimed = await prisma.callout.findUnique({ where: { id: callout.id } });
    expect(claimed.status).toBe('OPEN');
    await assertWallet(amateur.id, 10000000n);
  });

  it('insufficient funds leaves the callout open for the next player', async () => {
    const challenger = await makeUser('rich-c');
    const poor = await makeUser('poor-a', { balance: 0n });
    const callout = await makeCallout(challenger.id);

    await expect(acceptCallout(poor.id, callout.id))
      .rejects.toThrow('Insufficient funds');

    const claimed = await prisma.callout.findUnique({ where: { id: callout.id } });
    expect(claimed.status).toBe('OPEN');
    expect(claimed.acceptedBy).toBeNull();
    expect(await prisma.match.count({
      where: { OR: [{ playerLightId: challenger.id }, { playerDarkId: challenger.id }] }
    })).toBe(0);
  });
});