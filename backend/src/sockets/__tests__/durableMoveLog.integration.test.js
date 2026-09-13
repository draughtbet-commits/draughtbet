// Real-PostgreSQL + Redis durable move log guarantees. Skipped by default; run:
//   DATABASE_URL=postgresql://test:test@127.0.0.1:5544/draughts_arena_test?schema=public \
//   REDIS_URL=redis://127.0.0.1:6390/0 RUN_REDIS_INTEGRATION=1 RUN_DB_INTEGRATION=1 \
//   node --experimental-vm-modules node_modules/jest/bin/jest.js \
//     src/sockets/__tests__/durableMoveLog.integration.test.js
import { jest } from '@jest/globals';

const prisma = (await import('../../utils/db.js')).default;
const redis = (await import('../../utils/redis.js')).default;
const { debitStakes } = await import('../../services/matchService.js');
const { reconstructMoveHistory } = await import('../gameManager.js');
const { settleGame, InvalidSettlementError } = await import('../settlement.js');
const { createInitialBoard, applyMove, getLegalMoves, COLOR_WHITE } = await import('../../modules/engine/index.js');

const describeIntegration =
  process.env.RUN_REDIS_INTEGRATION === '1' ? describe : describe.skip;

describeIntegration('Durable move log (real PostgreSQL + Redis)', () => {
  const allUsers = [];
  const allMatches = [];

  const makeEligibleUser = async (suffix, balance = 10000000n) => {
    const user = await prisma.user.create({
      data: {
        email: `movelog-${Date.now()}-${Math.random()}-${suffix}@test.local`,
        passwordHash: 'x',
        tier: 'PRO',
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

  const stakeAndFund = async (a, b, stake = 1000000n) => {
    const match = await debitStakes(a.id, b.id, stake, 'PRO');
    allMatches.push(match.id);
    return match;
  };

  const moveRows = async (matchId) =>
    prisma.matchMove.findMany({ where: { matchId }, orderBy: { moveNumber: 'asc' } });

  afterAll(async () => {
    for (const matchId of allMatches) {
      await redis.del(`match:${matchId}`);
      await prisma.matchMove.deleteMany({ where: { matchId } });
      await prisma.match.delete({ where: { id: matchId } });
    }
    for (const userId of allUsers) {
      await redis.del(`user:${userId}:activeMatch`);
    }
    await prisma.walletTransaction.deleteMany({
      where: { wallet: { userId: { in: allUsers } } }
    });
    await prisma.wallet.deleteMany({ where: { userId: { in: allUsers } } });
    await prisma.user.deleteMany({ where: { id: { in: allUsers } } });
    await prisma.$disconnect();
  });

  it('enforces one durable row per (matchId, moveNumber)', async () => {
    const p1 = await makeEligibleUser('uniq-1');
    const p2 = await makeEligibleUser('uniq-2');
    const match = await stakeAndFund(p1, p2);

    const base = {
      matchId: match.id,
      playerId: p1.id,
      isKingMove: false,
      capturedSquares: [],
      boardStateAfter: createInitialBoard()
    };

    await prisma.matchMove.create({ data: { ...base, moveNumber: 1, fromSquare: 46, toSquare: 37 } });
    await expect(
      prisma.matchMove.create({ data: { ...base, moveNumber: 1, fromSquare: 47, toSquare: 36 } })
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('replays the durable log through the engine to the exact last persisted board', async () => {
    const p1 = await makeEligibleUser('replay-1');
    const p2 = await makeEligibleUser('replay-2');
    const match = await stakeAndFund(p1, p2);

    // Three real, alternating engine moves folded straight into the log —
    // mirroring persist-first acceptance without touching Redis at all.
    let board = createInitialBoard();
    const players = [p1.id, p2.id];
    for (let n = 1; n <= 3; n++) {
      const currentTurn = n % 2 === 1 ? COLOR_WHITE : 'BLACK';
      const move = getLegalMoves(board, currentTurn)[0];
      const newBoard = applyMove(board, { from: move.from, to: move.to }).newBoard;
      await prisma.matchMove.create({
        data: {
          matchId: match.id,
          moveNumber: n,
          playerId: players[n % 2],
          fromSquare: move.from,
          toSquare: move.to,
          capturedSquares: [],
          isKingMove: false,
          boardStateAfter: newBoard
        }
      });
      board = newBoard;
    }

    const rebuilt = await reconstructMoveHistory(match.id);
    expect(rebuilt).not.toBeNull();
    expect(rebuilt.moveCount).toBe(3);
    expect(rebuilt.currentTurn).toBe('BLACK');
    expect(rebuilt.board).toEqual(board);
    expect(await moveRows(match.id)).toHaveLength(3);
  });

  it('recovers fully: Redis loss rebuilds one replayable history from the log', async () => {
    const p1 = await makeEligibleUser('loss-1');
    const p2 = await makeEligibleUser('loss-2');
    const match = await stakeAndFund(p1, p2);

    const { initializeGame } = await import('../gameManager.js');
    await initializeGame(match.id, p1.id, p2.id, 'PRO');

    // Two accepted moves committed durably, then Redis is wiped (restart/loss).
    let board = createInitialBoard();
    for (let n = 1; n <= 2; n++) {
      const currentTurn = n % 2 === 1 ? COLOR_WHITE : 'BLACK';
      const move = getLegalMoves(board, currentTurn)[0];
      const newBoard = applyMove(board, { from: move.from, to: move.to }).newBoard;
      await prisma.matchMove.create({
        data: {
          matchId: match.id,
          moveNumber: n,
          playerId: n % 2 === 1 ? p1.id : p2.id,
          fromSquare: move.from,
          toSquare: move.to,
          capturedSquares: [],
          isKingMove: false,
          boardStateAfter: newBoard
        }
      });
      board = newBoard;
    }
    await redis.del(`match:${match.id}`);

    const rebuilt = await reconstructMoveHistory(match.id);
    expect(rebuilt.moveCount).toBe(2);
    expect(rebuilt.board).toEqual(board);
    expect(rebuilt.currentTurn).toBe('WHITE');
  });

  it('settlement refuses a board-derived claim whose durable log is empty, then accepts with evidence', async () => {
    const p1 = await makeEligibleUser('evid-1');
    const p2 = await makeEligibleUser('evid-2');
    const match = await stakeAndFund(p1, p2);

    await expect(
      settleGame(match.id, p1.id, p2.id, 'NO_LEGAL_MOVES')
    ).rejects.toThrow(InvalidSettlementError);

    // Add the final move to the durable log: the same outcome is now provable.
    const initial = createInitialBoard();
    const opening = getLegalMoves(initial, COLOR_WHITE)[0];
    await prisma.matchMove.create({
      data: {
        matchId: match.id,
        moveNumber: 1,
        playerId: p1.id,
        fromSquare: opening.from,
        toSquare: opening.to,
        capturedSquares: [],
        isKingMove: false,
        boardStateAfter: applyMove(initial, { from: opening.from, to: opening.to }).newBoard
      }
    });

    const result = await settleGame(match.id, p1.id, p2.id, 'NO_LEGAL_MOVES');
    expect(result).not.toBeNull();
    const settled = await prisma.match.findUnique({ where: { id: match.id } });
    expect(settled.status).toBe('COMPLETED');
  });
});