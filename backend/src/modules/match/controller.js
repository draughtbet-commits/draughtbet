import { Router } from 'express';
import { getGameState } from '../../sockets/gameManager.js';
import prisma from '../../utils/db.js';
import { requireAuth } from '../../middleware/auth.js';
import { createInitialBoard, applyMove, getLegalMoves } from '../engine/index.js';
import logger from '../../utils/logger.js';

export const matchRouter = Router();

matchRouter.get('/history', requireAuth, async (req, res) => {
  const userId = req.user.id;
  try {
    const matches = await prisma.match.findMany({
      where: {
        AND: [
          { OR: [{ playerLightId: userId }, { playerDarkId: userId }] },
          { status: 'COMPLETED' }
        ]
      },
      include: {
        playerLight: { select: { id: true, email: true } },
        playerDark: { select: { id: true, email: true } },
      },
      orderBy: { endedAt: 'desc' },
      take: 50,
    });

    return res.json({ matches });
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
        board,
        currentTurn,
        moveCount: parseInt(redisState.moveCount, 10),
        status: redisState.status,
        players: { light: match.playerLightId, dark: match.playerDarkId },
        winnerId: redisState.winnerId || null,
        legalMoves: getLegalMoves(board, currentTurn)
      });
    }

    // 3. Fallback to Postgres (rebuildBoardFromMoveLog)
    const moves = await prisma.matchMove.findMany({
      where: { matchId },
      orderBy: { moveNumber: 'asc' }
    });

    let board = createInitialBoard();
    let currentTurnStr = 'WHITE'; // Starting turn
    let moveCount = 0;

    for (const m of moves) {
      // Create a move object that applyMove expects
      const moveObj = {
        from: m.fromSquare,
        to: m.toSquare,
        capturedSquares: m.capturedSquares || []
      };
      
      board = applyMove(board, moveObj);
      currentTurnStr = currentTurnStr === 'WHITE' ? 'BLACK' : 'WHITE';
      moveCount = m.moveNumber;
    }
    
    return res.json({
      board,
      currentTurn: currentTurnStr,
      moveCount,
      status: match.status.toLowerCase(),
      players: { light: match.playerLightId, dark: match.playerDarkId },
      winnerId: match.winnerId,
      legalMoves: getLegalMoves(board, currentTurnStr)
    });

  } catch (err) {
    logger.error({ err, matchId, userId }, 'Error fetching match state');
    return res.status(500).json({ error: 'Internal server error' });
  }
});
