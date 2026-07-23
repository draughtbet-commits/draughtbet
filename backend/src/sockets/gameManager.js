import redis from '../utils/redis.js';
import logger from '../utils/logger.js';
import { createInitialBoard, getLegalMoves, applyMove, checkGameEnd, COLOR_WHITE, COLOR_BLACK, isKing } from '../modules/engine/index.js';
import { settleGame, settleGameDraw, settleGameWithRetry, settleGameDrawWithRetry } from './settlement.js';
import { getIO } from './index.js';
import prisma from '../utils/db.js';
import * as Sentry from '@sentry/node';

const GAME_STATE_TTL = 24 * 60 * 60; // 24 hours

// Lua script for atomic compare-and-swap
const casScript = `
local key = KEYS[1]
local currentVersion = redis.call('HGET', key, 'version')
if currentVersion == false then
  return redis.error_reply('GAME_NOT_FOUND')
end
if currentVersion ~= ARGV[1] then
  return redis.error_reply('VERSION_MISMATCH')
end
redis.call('HSET', key,
  'board',                  ARGV[2],
  'currentTurn',            ARGV[3],
  'currentTurnUserId',      ARGV[4],
  'version',                tostring(tonumber(currentVersion) + 1),
  'moveCount',              ARGV[5],
  'lastMoveTs',             ARGV[6],
  'positionCounts',         ARGV[7],
  'consecutiveKingMoves',   ARGV[8],
  'status',                 ARGV[9],
  'winnerId',               ARGV[10]
)
return 'OK'
`;

// Utility sleep function
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function persistMatchMove(moveData, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await prisma.matchMove.create({ data: moveData });
      return;
    } catch (err) {
      logger.warn({ err, attempt, matchId: moveData.matchId, moveNumber: moveData.moveNumber },
        'MatchMove persist failed, retrying');
      if (attempt === retries) {
        logger.error({ err, moveData },
          'CRITICAL: MatchMove persist failed after all retries. Move audit trail has a gap.');
        if (Sentry && typeof Sentry.captureException === 'function') {
          Sentry.captureException(err, {
            level: 'fatal',
            tags: { subsystem: 'match_audit' },
            extra: { matchId: moveData.matchId, moveNumber: moveData.moveNumber }
          });
        }
      } else {
        await sleep(attempt * 100);
      }
    }
  }
}

export const getActiveGameForUser = async (userId) => {
  return await redis.get(`user:${userId}:activeMatch`);
};

export const getOpponentId = async (matchId, userId) => {
  const [p1, p2] = await redis.hmget(`match:${matchId}`, 'player1', 'player2');
  if (p1 === userId) return p2;
  if (p2 === userId) return p1;
  return null;
};

export const getGameState = async (matchId) => {
  const state = await redis.hgetall(`match:${matchId}`);
  if (!state || Object.keys(state).length === 0) return null;
  return state;
};

export const initializeGame = async (matchId, player1Id, player2Id, stakeTier) => {
  const matchKey = `match:${matchId}`;
  const initialBoard = createInitialBoard();
  const boardHash = JSON.stringify([initialBoard, COLOR_WHITE]);
  
  const initialState = {
    player1: player1Id,
    player2: player2Id,
    currentTurn: COLOR_WHITE,
    currentTurnUserId: player1Id,
    board: JSON.stringify(initialBoard),
    status: 'in_progress',
    winnerId: '',
    stakeTier,
    moveCount: 0,
    version: 0,
    positionCounts: JSON.stringify({ [boardHash]: 1 }),
    consecutiveKingMoves: 0,
    lastMoveTs: Date.now()
  };
  
  try {
    await redis.hset(matchKey, initialState);
    await redis.expire(matchKey, GAME_STATE_TTL);
    await redis.set(`user:${player1Id}:activeMatch`, matchId);
    await redis.set(`user:${player2Id}:activeMatch`, matchId);
    
    return {
      ...initialState,
      board: initialBoard,
      positionCounts: { [boardHash]: 1 }
    };
  } catch (err) {
    logger.error({ err, matchId }, 'Failed to initialize game state in Redis');
    throw err;
  }
};

export const handleResign = async (socket, { matchId }) => {
  const userId = socket.user?.userId;
  if (!userId) return;

  const state = await getGameState(matchId);
  if (!state) {
    socket.emit('error', { message: 'Game not found' });
    return;
  }
  
  if (state.player1 !== userId && state.player2 !== userId) {
    socket.emit('error', { message: 'Not authorized' });
    return;
  }

  const opponentId = state.player1 === userId ? state.player2 : state.player1;

  try {
    // We execute the CAS script for resignation, which flips status to completed and sets winner.
    await redis.eval(
      casScript,
      1,
      `match:${matchId}`,
      state.version,
      state.board,
      state.currentTurn,
      state.currentTurnUserId,
      state.moveCount,
      Date.now().toString(),
      state.positionCounts,
      state.consecutiveKingMoves,
      'completed',
      opponentId
    );

    const io = getIO();
    io.to(`match:${matchId}`).emit('match_ended_resign', { winnerId: opponentId, resignedId: userId });
    
    // Call settleGame
    await settleGameWithRetry(matchId, opponentId, userId, 'resign');
  } catch (err) {
    if (err.message && err.message.includes('VERSION_MISMATCH')) {
      logger.info('Resign VERSION_MISMATCH, retry generally unneeded if resigning again');
    } else {
      logger.error({ err, matchId }, 'Error in handleResign');
    }
  }
};

export const handleMoveAttempt = async (socket, { matchId, from, to }) => {
  const userId = socket.user?.userId;
  if (!userId) return;

  let retries = 2;
  let success = false;

  while (retries >= 0 && !success) {
    try {
      // 1. Read
      const state = await getGameState(matchId);
      if (!state) {
        socket.emit('move_rejected', { reason: 'game_already_ended' });
        return;
      }
      
      if (state.status !== 'in_progress') {
        socket.emit('move_rejected', { reason: 'game_not_in_progress' });
        return;
      }
      
      if (state.currentTurnUserId !== userId) {
        socket.emit('move_rejected', { reason: 'not_your_turn' });
        return;
      }

      // 2. Validate
      const board = JSON.parse(state.board);
      const legalMoves = getLegalMoves(board, state.currentTurn);
      
      const move = legalMoves.find(m => m.from === from && m.to === to);
      if (!move) {
        socket.emit('move_rejected', { reason: 'illegal_move' });
        return;
      }

      const newBoard = applyMove(board, move);
      const nextTurn = state.currentTurn === COLOR_WHITE ? COLOR_BLACK : COLOR_WHITE;
      const nextTurnUserId = nextTurn === COLOR_WHITE ? state.player1 : state.player2;
      const moveCount = parseInt(state.moveCount, 10) + 1;
      
      // Update counts
      let consecutiveKingMoves = parseInt(state.consecutiveKingMoves, 10);
      const pieceMoved = board[from - 1]; // from is 1-indexed
      if (isKing(pieceMoved) && (!move.capturedSquares || move.capturedSquares.length === 0)) {
        consecutiveKingMoves++;
      } else {
        consecutiveKingMoves = 0;
      }

      const positionCounts = JSON.parse(state.positionCounts);
      const newHash = JSON.stringify([newBoard, nextTurn]);
      positionCounts[newHash] = (positionCounts[newHash] || 0) + 1;

      // Check game end
      const { ended, reason, winner } = checkGameEnd(newBoard, nextTurn, positionCounts, consecutiveKingMoves);
      let newStatus = 'in_progress';
      let winnerId = '';
      
      if (ended) {
        if (winner) {
          newStatus = 'completed';
          winnerId = winner === COLOR_WHITE ? state.player1 : state.player2;
        } else {
          newStatus = 'draw';
        }
      }

      // 3. CAS Write
      await redis.eval(
        casScript,
        1,
        `match:${matchId}`,
        state.version,
        JSON.stringify(newBoard),
        nextTurn,
        nextTurnUserId,
        moveCount.toString(),
        Date.now().toString(),
        JSON.stringify(positionCounts),
        consecutiveKingMoves.toString(),
        newStatus,
        winnerId
      );

      success = true;

      // Emit to room
      const io = getIO();
      io.to(`match:${matchId}`).emit('move_applied', {
        from, to,
        captured: move.capturedSquares || [],
        promoted: move.promoted, // Assuming engine sets this
        nextTurn,
        gameEnded: ended,
        reason
      });

      // Persist move async
      persistMatchMove({
        matchId,
        moveNumber: moveCount,
        playerId: userId,
        fromSquare: from,
        toSquare: to,
        capturedSquares: move.capturedSquares || [],
        isKingMove: isKing(pieceMoved),
        boardStateAfter: newBoard
      });

      // Settlement
      if (ended) {
        if (newStatus === 'completed') {
          const loserId = winnerId === state.player1 ? state.player2 : state.player1;
          settleGameWithRetry(matchId, winnerId, loserId, reason);
        } else {
          settleGameDrawWithRetry(matchId, reason);
        }
      }

    } catch (err) {
      if (err.message && err.message.includes('VERSION_MISMATCH')) {
        retries--;
        if (retries < 0) {
          socket.emit('move_rejected', { reason: 'server_busy' });
        }
      } else if (err.message && err.message.includes('GAME_NOT_FOUND')) {
        socket.emit('move_rejected', { reason: 'game_already_ended' });
        return;
      } else {
        logger.error({ err, matchId }, 'Error in handleMoveAttempt');
        socket.emit('error', { message: 'Internal server error processing move' });
        return;
      }
    }
  }
};
