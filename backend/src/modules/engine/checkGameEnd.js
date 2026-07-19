import { getLegalMoves } from './moves.js';
import { isThreefoldRepetition, isTwentyFiveKingMoveDraw } from './draws.js';
import { COLOR_WHITE, COLOR_BLACK } from './board.js';

export const REASON_NO_LEGAL_MOVES = 'NO_LEGAL_MOVES';
export const REASON_DRAW_THREEFOLD = 'DRAW_THREEFOLD';
export const REASON_DRAW_25_KING_MOVES = 'DRAW_25_KING_MOVES';

/**
 * Checks if the game has ended based on current board state and history.
 * @param {Array} board - The 1D board array
 * @param {String} colorToMove - 'WHITE' or 'BLACK'
 * @param {Array} history - Array of { board, colorToMove, move }
 * @returns {Object} { ended: boolean, reason: string | null, winner: string | null }
 */
export function checkGameEnd(board, colorToMove, history) {
  // 1. Draw checks
  if (isThreefoldRepetition(history)) {
    return { ended: true, reason: REASON_DRAW_THREEFOLD, winner: null };
  }
  
  if (isTwentyFiveKingMoveDraw(history)) {
    return { ended: true, reason: REASON_DRAW_25_KING_MOVES, winner: null };
  }
  
  // 2. Win / Loss checks (No legal moves left)
  const legalMoves = getLegalMoves(board, colorToMove);
  if (legalMoves.length === 0) {
    const winner = colorToMove === COLOR_WHITE ? COLOR_BLACK : COLOR_WHITE;
    return { ended: true, reason: REASON_NO_LEGAL_MOVES, winner };
  }
  
  return { ended: false, reason: null, winner: null };
}
