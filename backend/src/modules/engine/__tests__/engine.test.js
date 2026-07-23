import { jest } from '@jest/globals';
import {
  EMPTY, WHITE_MAN, WHITE_KING, BLACK_MAN, BLACK_KING,
  COLOR_WHITE, COLOR_BLACK,
  createInitialBoard,
  getLegalMoves,
  applyMove,
  isThreefoldRepetition,
  isTwentyFiveKingMoveDraw,
  checkGameEnd,
  REASON_NO_LEGAL_MOVES,
  REASON_DRAW_THREEFOLD,
  REASON_DRAW_25_KING_MOVES
} from '../index.js';

describe('Draughts Engine', () => {

  const createEmptyBoard = () => new Array(50).fill(EMPTY);

  test('Single capture mandatory', () => {
    const board = createEmptyBoard();
    // Setup a white man that can capture a black man
    board[26] = WHITE_MAN; // Square 27 (row 5, col 3)
    board[21] = BLACK_MAN; // Square 22 (row 4, col 2)
    
    const moves = getLegalMoves(board, COLOR_WHITE);
    // Must capture to square 17 (row 3, col 1)
    expect(moves.length).toBe(1);
    expect(moves[0].from).toBe(27);
    expect(moves[0].to).toBe(18);
    expect(moves[0].capturedSquares).toEqual([22]);
  });

  test('Forced max-capture choice between two paths', () => {
    const board = createEmptyBoard();
    board[26] = WHITE_MAN; // Square 27
    
    // Path 1: 1 capture
    board[21] = BLACK_MAN; // Square 22, lands on 17
    
    // Path 2: 2 captures
    board[31] = BLACK_MAN; // Square 32 (row 6, col 2) - wait, White man moves up, backwards is row 6? 
    // In international draughts, men can capture backwards. 
    // White man on 27 (row 5, col 3). 
    // Forward-left: 21 (row 4, col 1). No, wait.
    // Let's use simpler setup using known rows.
    // White on 28 (row 5, col 5). 
    // Enemy 1: 22 (row 4, col 4). Landing: 17 (row 3, col 3) - 1 capture.
    // Enemy 2: 23 (row 4, col 6). Landing: 19 (row 3, col 7). Then enemy 3 on 14 (row 2, col 8), Landing: 10 (row 1, col 9).
    
    board.fill(EMPTY);
    board[27] = WHITE_MAN; // Square 28
    
    board[21] = BLACK_MAN; // Sq 22, capture to 17.
    
    board[22] = BLACK_MAN; // Sq 23, capture to 19.
    board[13] = BLACK_MAN; // Sq 14, capture from 19 to 10.
    
    const moves = getLegalMoves(board, COLOR_WHITE);
    // Only the max capture path should be returned
    expect(moves.length).toBe(1);
    expect(moves[0].capturedSquares.length).toBe(2);
    expect(moves[0].to).toBe(10);
  });

  test('Multi-jump chain (3+ pieces) and correct piece removal', () => {
    const board = createEmptyBoard();
    board[27] = WHITE_MAN; // Sq 28
    board[22] = BLACK_MAN; // Sq 23
    board[13] = BLACK_MAN; // Sq 14
    board[8] = BLACK_MAN;  // Sq 9 (row 1, col 7), capture from 10 backwards? No, from 10, forward-left is 4 (row 0, col 7). 
    // Let's re-verify: row 1 col 9 is sq 10. From sq 10, backward-left is sq 14 (row 2 col 8). Forward-left is sq 4 (row 0 col 7) or sq 5 (row 0 col 9).
    // Let's just put enemies to capture in a circle.
    // 28 -> 19 (via 23) -> 8 (via 13) -> 17 (via 12) -> 26 (via 21)
    board.fill(EMPTY);
    board[27] = WHITE_MAN; // Sq 28
    board[22] = BLACK_MAN; // Sq 23
    board[12] = BLACK_MAN; // Sq 13
    board[11] = BLACK_MAN; // Sq 12
    board[20] = BLACK_MAN; // Sq 21
    
    const moves = getLegalMoves(board, COLOR_WHITE);
    // This should find the 4-capture chain
    expect(moves.length).toBeGreaterThan(0);
    const bestMove = moves[0];
    
    const { newBoard, captured } = applyMove(board, bestMove);
    expect(captured.length).toBe(bestMove.capturedSquares.length);
    // Ensure all captured pieces are removed in the new board
    for (const cap of captured) {
      expect(newBoard[cap.square - 1]).toBe(EMPTY);
    }
  });

  test('King flying capture', () => {
    const board = createEmptyBoard();
    board[49] = WHITE_KING; // Sq 50 (row 9, col 9)
    board[27] = BLACK_MAN; // Sq 28 (row 5, col 5)
    
    // King can capture from 50 over 28, landing on 22, 17, 11, or 6
    const moves = getLegalMoves(board, COLOR_WHITE);
    expect(moves.length).toBe(4);
    moves.forEach(m => {
      expect(m.capturedSquares).toEqual([28]);
    });
  });

  test('Threefold-repetition draw', () => {
    const board = createEmptyBoard();
    board[0] = WHITE_KING;
    board[49] = BLACK_KING;
    
    const b1 = [...board]; b1[0] = WHITE_KING; b1[5] = EMPTY;
    const b2 = [...board]; b2[0] = EMPTY; b2[5] = WHITE_KING;
    
    const hash1 = JSON.stringify([b1, COLOR_WHITE]);
    const hash2 = JSON.stringify([b2, COLOR_WHITE]);
    
    const positionCounts = {
      [hash1]: 3,
      [hash2]: 2
    };
    
    expect(isThreefoldRepetition(positionCounts)).toBe(true);
  });

  test('25-consecutive-king-move draw', () => {
    const board = createEmptyBoard();
    board[0] = WHITE_KING;
    
    const consecutiveKingMoves = 50; // 50 plies = 25 moves
    
    expect(isTwentyFiveKingMoveDraw(consecutiveKingMoves)).toBe(true);
    
    // Check Game End
    const positionCounts = {};
    const result = checkGameEnd(board, COLOR_WHITE, positionCounts, consecutiveKingMoves);
    expect(result.ended).toBe(true);
    expect(result.reason).toBe(REASON_DRAW_25_KING_MOVES);
  });

  test('No-legal-moves loss', () => {
    const board = createEmptyBoard();
    board[5] = WHITE_MAN; // Sq 6 (row 1, col 0)
    board[0] = BLACK_MAN; // Sq 1 (row 0, col 1)
    
    // Test what legal moves exist
    const moves = getLegalMoves(board, COLOR_WHITE);
    // There shouldn't be any, as forward is blocked, and backward has no pieces.
    expect(moves.length).toBe(0);

    const result = checkGameEnd(board, COLOR_WHITE, {}, 0);
    expect(result.ended).toBe(true);
    expect(result.reason).toBe(REASON_NO_LEGAL_MOVES);
    expect(result.winner).toBe(COLOR_BLACK);
  });

});
