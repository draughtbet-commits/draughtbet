// Real-PostgreSQL + Redis turn-deadline guarantees. Skipped by default; run:
//   DATABASE_URL=postgresql://test:test@127.0.0.1:5544/draughts_arena_test?schema=public \
//   REDIS_URL=redis://127.0.0.1:6390/0 RUN_REDIS_INTEGRATION=1 RUN_DB_INTEGRATION=1 \
//   node --experimental-vm-modules node_modules/jest/bin/jest.js \
//     src/sockets/__tests__/timeControl.integration.test.js
import { jest } from '@jest/globals';

const prisma = (await import('../../utils/db.js')).default;
const redis = (await import('../../utils/redis.js')).default;
const { debitStakes } = await import('../../services/matchService.js');
const { initializeGame, casScript } = await import('../gameManager.js');
const { processTurnDeadlineSweep } = await import('../../jobs/turnDeadlineSweep.js');
const { recoverLiveGames } = await import('../gameRecovery.js');
const { createInitialBoard } = await import('../../modules/engine/index.js');
const { getUserLedgerProjections, ensureUserAccounts, ensureSystemAccount, postLedgerTransaction } = await import('../../services/ledgerService.js');

const describeIntegration =
  process.env.RUN_REDIS_INTEGRATION === '1' ? describe : describe.skip;

describeIntegration('Turn deadlines (real PostgreSQL + Redis)', () => {
  const settings = { id: 'singleton', commissionPercent: 10, timeControlSeconds: 60 };
  const allUsers = [];
  const allMatches = [];

  // Seeds a wallet's opening balance as a ledger ADJUSTMENT (same shape as the
  // legacy backfill) so AVAILABLE == the balance everywhere below.
  const postOpeningBalance = async (wallet, amountMinorUnits) => {
    await prisma.$transaction(async (tx) => {
      const accounts = await ensureUserAccounts(tx, wallet.userId, wallet.currency ?? 'NGN');
      const clearing = await ensureSystemAccount(tx, 'SYSTEM_OPENING_CLEARING', wallet.currency ?? 'NGN');
      await postLedgerTransaction(tx, {
        type: 'ADJUSTMENT',
        description: 'Opening balance carried over from legacy wallet',
        idempotencyKey: `opening-balance:${wallet.id}`,
        metadata: { walletId: wallet.id, source: 'legacy-wallet-backfill' },
        entries: [
          { accountId: clearing.id, amountMinorUnits: -amountMinorUnits },
          { accountId: accounts.PLAYER_AVAILABLE.id, amountMinorUnits: amountMinorUnits }
        ]
      });
    });
  };

  const makeEligibleUser = async (suffix, balance = 10000000n) => {
    const user = await prisma.user.create({
      data: {
        email: `timectl-${Date.now()}-${Math.random()}-${suffix}@test.local`,
        passwordHash: 'x',
        tier: 'PRO',
        kycStatus: 'VERIFIED',
        countryCode: 'NG',
        eligibility: {
          create: { countryCode: 'NG', countryAllowed: true, ageVerified: true }
        }
      }
    });
    const wallet = await prisma.wallet.create({ data: { userId: user.id } });
    await postOpeningBalance(wallet, balance);
    allUsers.push(user.id);
    return user;
  };

  const stakeAndFund = async (a, b, stake = 1000000n) => {
    const match = await debitStakes(a.id, b.id, stake, 'PRO');
    allMatches.push(match.id);
    return match;
  };

  const balance = async (userId) => {
    const proj = await getUserLedgerProjections(prisma, userId);
    return BigInt(proj.available);
  };

  beforeEach(async () => {
    await prisma.platformSettings.upsert({
      where: settings,
      create: settings,
      update: { commissionPercent: 10, timeControlSeconds: 60 }
    });
  });

  afterAll(async () => {
    for (const matchId of allMatches) {
      await redis.del(`match:${matchId}`);
      await prisma.matchMove.deleteMany({ where: { matchId } });
      await prisma.match.delete({ where: { id: matchId } });
    }
    for (const userId of allUsers) {
      await redis.del(`user:${userId}:activeMatch`);
    }
    await prisma.wallet.deleteMany({ where: { userId: { in: allUsers } } });
    // V2 ledger rows must go before users: user delete cascades LedgerAccount,
    // but LedgerEntry.account is onDelete Restrict. Opening-balance postings
    // (source: legacy-wallet-backfill) carry no matchId and must be removed too.
    await prisma.ledgerTransaction.deleteMany({
      where: {
        OR: [
          { relatedMatchId: { in: allMatches } },
          { metadata: { path: ['source'], equals: 'legacy-wallet-backfill' } }
        ]
      }
    });
    await prisma.notification.deleteMany({ where: { userId: { in: allUsers } } });
    await prisma.user.deleteMany({ where: { id: { in: allUsers } } });
    await prisma.$disconnect();
  });

  it('CAS script compiles and refuses transitions on an expired turn', async () => {
    const key = `match:tc-gate-${Date.now()}`;
    const board = JSON.stringify(new Array(50).fill(0));
    const now = Date.now();

    await redis.hset(key, {
      player1: 'a', player2: 'b', board,
      status: 'in_progress', winnerId: '', version: '0', moveCount: '0',
      lastMoveTs: String(now - 70000), positionCounts: JSON.stringify({}),
      consecutiveKingMoves: '0', timeControlSeconds: '60',
      deadlineAt: String(now - 1000)
    });

    // Non-ending transition on an expired turn is refused atomically.
    await expect(
      redis.eval(casScript, 1, key, '0', board, 'BLACK', 'b', '1', String(now),
        JSON.stringify({}), '0', 'in_progress', '', String(now + 60000), '60', String(now))
    ).rejects.toThrow('TURN_EXPIRED');

    // A turn still inside its deadline lands, persists the deadline for the
    // next move, and advances the version.
    await redis.hset(key, 'deadlineAt', String(now + 60000));
    const appliedDeadline = String(now + 119000);
    await expect(
      redis.eval(casScript, 1, key, '0', board, 'BLACK', 'b', '1', String(now),
        JSON.stringify({}), '0', 'in_progress', '', appliedDeadline, '60', String(now))
    ).resolves.toBe('OK');
    const live = await redis.hgetall(key);
    expect(live.status).toBe('in_progress');
    expect(live.deadlineAt).toBe(appliedDeadline);
    expect(live.timeControlSeconds).toBe('60');
    expect(live.version).toBe('1');

    // Ending transitions pass even when the clock is expired.
    await redis.hset(key, { deadlineAt: String(now - 1000) });
    await expect(
      redis.eval(casScript, 1, key, '1', board, 'BLACK', 'b', '1', String(now),
        JSON.stringify({}), '0', 'completed', 'a', '', '60', '')
    ).resolves.toBe('OK');
    const after = await redis.hgetall(key);
    expect(after.status).toBe('completed');
    expect(after.winnerId).toBe('a');

    await redis.del(key);
  });

  it('deadline sweep forfeits the player on the clock end to end', async () => {
    const p1 = await makeEligibleUser('sweep-1');
    const p2 = await makeEligibleUser('sweep-2');
    const match = await stakeAndFund(p1, p2);
    await initializeGame(match.id, p1.id, p2.id, 'PRO');

    // White (p1) opened the game; backdate the deadline so p1's turn is over.
    await redis.hset(`match:${match.id}`, 'deadlineAt', String(Date.now() - 1000));

    const result = await processTurnDeadlineSweep();
    expect(result.settled).toContain(match.id);

    const settled = await prisma.match.findUnique({ where: { id: match.id } });
    expect(settled.status).toBe('SETTLED');
    expect(settled.winnerId).toBe(p2.id);
    expect(settled.endReason).toBe('timeout_forfeit');

    // Cleanup ran: the live Redis projection is gone and the winner is paid
    // (pot minus the 10% commission snapshot), the loser keeps their stake loss.
    expect(await redis.exists(`match:${match.id}`)).toBe(0);
    expect(await balance(p2.id)).toBe(10000000n - 1000000n + 1800000n);
    expect(await balance(p1.id)).toBe(9000000n);
  });

  it('deadline sweep leaves matches inside their turn untouched', async () => {
    const p1 = await makeEligibleUser('fresh-1');
    const p2 = await makeEligibleUser('fresh-2');
    const match = await stakeAndFund(p1, p2);
    await initializeGame(match.id, p1.id, p2.id, 'PRO');

    await processTurnDeadlineSweep();

    // initializeGame is the server-authoritative start: FUNDED -> IN_PLAY, and an
    // unexpired turn leaves the match live and untouched.
    const active = await prisma.match.findUnique({ where: { id: match.id } });
    expect(active.status).toBe('IN_PLAY');
    expect(await redis.exists(`match:${match.id}`)).toBe(1);
  });

  it('boot recovery rehydrates a live match from durable state', async () => {
    const p1 = await makeEligibleUser('recover-1');
    const p2 = await makeEligibleUser('recover-2');
    const match = await stakeAndFund(p1, p2);
    await initializeGame(match.id, p1.id, p2.id, 'PRO');
    await prisma.matchGameState.create({
      data: {
        matchId: match.id,
        boardState: createInitialBoard(),
        currentTurn: 'LIGHT',
        stateVersion: 0
      }
    });

    // A restart lost the projection and the participant pointers.
    await redis.del(`match:${match.id}`);
    await redis.del(`user:${p1.id}:activeMatch`);
    await redis.del(`user:${p2.id}:activeMatch`);

    const result = await recoverLiveGames();

    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(await redis.exists(`match:${match.id}`)).toBe(1);
    expect(await redis.get(`user:${p1.id}:activeMatch`)).toBe(match.id);
    expect(await redis.get(`user:${p2.id}:activeMatch`)).toBe(match.id);
  });
});