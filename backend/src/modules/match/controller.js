import { Router } from 'express';
import { getGameState, reconstructMoveHistory } from '../../sockets/gameManager.js';
import prisma from '../../utils/db.js';
import { requireAuth } from '../../middleware/auth.js';
import { createInitialBoard, getLegalMoves, COLOR_WHITE } from '../engine/index.js';
import logger from '../../utils/logger.js';

export const matchRouter = Router();

matchRouter.get('/history', requireAuth, async (req, res) => {
  const userId = req.user.id;
  try {
    const matches = await prisma.match.findMany({
      where: {
        AND: [
          { OR: [{ playerLightId: userId }, { playerDarkId: userId }] },
          // V2 settlement writes SETTLED; legacy COMPLETED rows remain.
          { status: { in: ['COMPLETED', 'SETTLED'] } }
        ]
      },
      orderBy: { endedAt: 'desc' },
      take: 50,
    });

    const playerIds = new Set();
    for (const m of matches) {
      playerIds.add(m.playerLightId);
      playerIds.add(m.playerDarkId);
    }
    const users = await prisma.user.findMany({
      where: { id: { in: [...playerIds] } },
      select: { id: true, username: true },
    });
    const usernameById = new Map(users.map((u) => [u.id, u.username]));

    const sanitized = matches.map((m) => ({
      id: m.id,
      playerLightId: m.playerLightId,
      playerDarkId: m.playerDarkId,
      // Only the public handle is exposed — never the account email (S17).
      playerLight: { id: m.playerLightId, username: usernameById.get(m.playerLightId) ?? null },
      playerDark: { id: m.playerDarkId, username: usernameById.get(m.playerDarkId) ?? null },
      tier: m.tier,
      stakeMinorUnits: m.stakeMinorUnits.toString(),
      status: m.status,
      winnerId: m.winnerId,
      endReason: m.endReason,
      createdAt: m.createdAt,
      endedAt: m.endedAt,
    }));

    return res.json({ matches: sanitized });
  } catch (err) {
    logger.error({ err, userId }, 'Error fetching match history');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

matchRouter.get('/:id/state', requireAuth, async (req, res) => {
  const matchId = req.params.id;
  const userId = req.user.id;

  try {
    // 1. Verify user is in this match
    const match = await prisma.match.findUnique({
      where: { id: matchId },
      select: { playerLightId: true, playerDarkId: true, status: true, winnerId: true }
    });

    if (!match) {
      return res.status(404).json({ error: 'Match not found' });
    }

    if (match.playerLightId !== userId && match.playerDarkId !== userId) {
      return res.status(403).json({ error: 'Not authorized to view this match' });
    }

    // 2. Try Redis first
    const redisState = await getGameState(matchId);
    if (redisState) {
      const board = JSON.parse(redisState.board);
      const currentTurn = redisState.currentTurn;
      return res.json({
        matchId,
        version: parseInt(redisState.version, 10),
        board,
        currentTurn,
        moveCount: parseInt(redisState.moveCount, 10),
        status: redisState.status,
        players: { light: match.playerLightId, dark: match.playerDarkId },
        winnerId: redisState.winnerId || null,
        legalMoves: getLegalMoves(board, currentTurn)
      });
    }

    // 3. Fallback to the durable move log (Redis loss or restart). The log is
    //    replayed through the engine, so the returned board is exactly the
    //    state before the last accepted move.
    const rebuilt = await reconstructMoveHistory(matchId);
    if (rebuilt) {
      return res.json({
        matchId,
        version: rebuilt.moveCount,
        board: rebuilt.board,
        currentTurn: rebuilt.currentTurn,
        moveCount: rebuilt.moveCount,
        status: match.status.toLowerCase(),
        players: { light: match.playerLightId, dark: match.playerDarkId },
        winnerId: match.winnerId,
        legalMoves: getLegalMoves(rebuilt.board, rebuilt.currentTurn)
      });
    }

    // A freshly activated match whose Redis state was lost before any move:
    // return the pristine starting position.
    const initialBoard = createInitialBoard();
    return res.json({
      matchId,
      version: 0,
      board: initialBoard,
      currentTurn: COLOR_WHITE,
      moveCount: 0,
      status: match.status.toLowerCase(),
      players: { light: match.playerLightId, dark: match.playerDarkId },
      winnerId: match.winnerId,
      legalMoves: getLegalMoves(initialBoard, COLOR_WHITE)
    });

  } catch (err) {
    logger.error({ err, matchId, userId }, 'Error fetching match state');
    return res.status(500).json({ error: 'Internal server error' });
  }
});
