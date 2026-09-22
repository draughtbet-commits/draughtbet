import { Router } from 'express';
import { getGameState, reconstructMoveHistory } from '../../sockets/gameManager.js';
import prisma from '../../utils/db.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireIdempotencyKey } from '../../middleware/idempotency.js';
import { createInitialBoard, getLegalMoves, COLOR_WHITE } from '../engine/index.js';
import { markReady, MatchNotFoundError, NotParticipantError, MatchNotReadyError } from './service.js';
import { cancelPreplayMatch, MatchNotCancellableError } from '../../services/gameActivationService.js';
import logger from '../../utils/logger.js';

export const matchRouter = Router();

// Both players are in Match.playerLightId/playerDarkId AND MatchParticipant —
// the flat columns are the migration-safe check for legacy pre-V2 rows.
const isParticipant = (match, userId) =>
  match.playerLightId === userId || match.playerDarkId === userId;

// A user holding any admin role may also read settlement evidence on a match.
const isAdmin = async (userId) => {
  const rows = await prisma.adminRoleAssignment.findMany({
    where: { userId },
    select: { id: true },
    take: 1
  });
  return rows.length > 0;
};

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

// ---------------------------------------------------------------------------
// Contract §8: GET /matches/{matchId}/receipt — immutable settlement receipt,
// served from MatchReceipt/MatchSettlement rows only (never regenerated). A
// match that has not settled returns SETTLEMENT_PENDING.
// ---------------------------------------------------------------------------
matchRouter.get('/:matchId/receipt', requireAuth, async (req, res, next) => {
  try {
    const matchId = req.params.matchId;
    const match = await prisma.match.findUnique({
      where: { id: matchId },
      select: {
        id: true,
        playerLightId: true,
        playerDarkId: true,
        status: true,
        winnerId: true,
        endReason: true,
        endedAt: true
      }
    });
    if (!match) return res.status(404).json({ error: { code: 'MATCH_NOT_FOUND', message: 'Match not found' } });
    if (!isParticipant(match, req.user.id) && !(await isAdmin(req.user.id))) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not authorized to view this match' } });
    }

    const [settlement, receipts] = await Promise.all([
      prisma.matchSettlement.findUnique({ where: { matchId } }),
      prisma.matchReceipt.findMany({ where: { matchId } })
    ]);

    if (receipts.length === 0) {
      return res.json({ matchId, status: 'SETTLEMENT_PENDING', receipts: [] });
    }

    const winnerId = settlement?.winnerId ?? match.winnerId ?? null;
    const resultFor = (r) =>
      r.payoutMinorUnits > 0n ? (winnerId === r.userId ? 'WIN' : 'REFUND') : 'LOSS';

    res.json({
      matchId,
      status: 'SETTLED',
      winnerId,
      endReason: settlement?.endReason ?? match.endReason,
      settledAt: settlement?.settledAt ?? match.endedAt ?? null,
      receipts: receipts.map((r) => ({
        userId: r.userId,
        result: resultFor(r),
        stakeMinorUnits: r.stakeMinorUnits.toString(),
        payoutMinorUnits: r.payoutMinorUnits.toString(),
        feeMinorUnits: r.feeMinorUnits.toString(),
        createdAt: r.createdAt
      }))
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Contract §8: GET /matches/{matchId}/replay — durable move + event log read
// straight from MatchMove/GameEvent. Never regenerated from mutable config.
// ---------------------------------------------------------------------------
matchRouter.get('/:matchId/replay', requireAuth, async (req, res, next) => {
  try {
    const matchId = req.params.matchId;
    const match = await prisma.match.findUnique({
      where: { id: matchId },
      select: {
        id: true,
        playerLightId: true,
        playerDarkId: true,
        status: true,
        winnerId: true,
        endReason: true,
        startedAt: true,
        endedAt: true
      }
    });
    if (!match) return res.status(404).json({ error: { code: 'MATCH_NOT_FOUND', message: 'Match not found' } });
    if (!isParticipant(match, req.user.id) && !(await isAdmin(req.user.id))) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not authorized to view this match' } });
    }

    const [moves, events] = await Promise.all([
      prisma.matchMove.findMany({
        where: { matchId },
        orderBy: { moveNumber: 'asc' }
      }),
      prisma.gameEvent.findMany({
        where: { matchId },
        orderBy: { createdAt: 'asc' }
      })
    ]);

    res.json({
      matchId,
      players: { light: match.playerLightId, dark: match.playerDarkId },
      status: match.status,
      winnerId: match.winnerId,
      endReason: match.endReason,
      startedAt: match.startedAt ?? null,
      endedAt: match.endedAt ?? null,
      moves: moves.map((m) => ({
        moveNumber: m.moveNumber,
        playerId: m.playerId,
        from: m.fromSquare,
        to: m.toSquare,
        captured: m.capturedSquares,
        path: m.path,
        stateVersion: m.stateVersion,
        at: m.createdAt
      })),
      events: events.map((e) => ({
        type: e.type,
        playerId: e.playerId,
        payload: e.payload,
        at: e.createdAt
      }))
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Contract §7: POST /matches/{matchId}/ready — a participant marks readiness.
// Only a FUNDED match advances to READY; retries are idempotent. The
// two-player readiness gate/timeout is coordinated in the socket layer.
// ---------------------------------------------------------------------------
matchRouter.post('/:matchId/ready', requireAuth, requireIdempotencyKey({ scope: 'match' }), async (req, res, next) => {
  try {
    const result = await markReady(prisma, req.params.matchId, req.user.id);
    res.json(result);
  } catch (err) {
    if (err instanceof MatchNotFoundError) return res.status(404).json({ error: { code: 'MATCH_NOT_FOUND', message: err.message } });
    if (err instanceof NotParticipantError) return res.status(403).json({ error: { code: 'FORBIDDEN', message: err.message } });
    if (err instanceof MatchNotReadyError) return res.status(409).json({ error: { code: 'MATCH_NOT_READY', message: err.message } });
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Contract §7: POST /matches/{matchId}/cancel — policy-controlled pre-play
// cancellation. A live match is always refused (MATCH_CANNOT_BE_CANCELLED).
// ---------------------------------------------------------------------------
matchRouter.post('/:matchId/cancel', requireAuth, requireIdempotencyKey({ scope: 'match' }), async (req, res, next) => {
  try {
    const matchId = req.params.matchId;
    const match = await prisma.match.findUnique({
      where: { id: matchId },
      select: { id: true, playerLightId: true, playerDarkId: true }
    });
    if (!match) return res.status(404).json({ error: { code: 'MATCH_NOT_FOUND', message: 'Match not found' } });
    if (!isParticipant(match, req.user.id)) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not authorized to cancel this match' } });
    }
    const result = await cancelPreplayMatch(matchId);
    res.json(result);
  } catch (err) {
    if (err instanceof MatchNotCancellableError) {
      return res.status(409).json({ error: { code: 'MATCH_CANNOT_BE_CANCELLED', message: err.message } });
    }
    next(err);
  }
});
