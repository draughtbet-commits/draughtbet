import { isKing, EMPTY } from './board.js';

/**
 * Checks if the current board state has occurred 3 times.
 * @param {Array} history - Array of { board: Array, colorToMove: String }
 */
export function isThreefoldRepetition(history) {
  if (history.length < 5) return false; // Need at least 5 plies for 3 repetitions

  const currentState = history[history.length - 1];
  const currentSerialized = currentState.board.join(',') + '|' + currentState.colorToMove;
  
  let count = 0;
  for (const state of history) {
    const serialized = state.board.join(',') + '|' + state.colorToMove;
    if (serialized === currentSerialized) {
      count++;
    }
  }
  
  return count >= 3;
}

/**
 * In International Draughts, if only kings are moving and no captures are made
 * for 25 consecutive moves (50 plies), it's a draw.
 * 
 * history item should ideally include `{ pieceMoved, captured: boolean }` or similar.
 * Assuming history includes `{ board, move }` where move is the move applied.
 */
export function isTwentyFiveKingMoveDraw(history) {
  let consecutiveKingMoves = 0;
  
  // Look backward from the most recent move
  for (let i = history.length - 1; i >= 0; i--) {
    const state = history[i];
    if (!state.move) break; // Initial state has no move
    
    // If the move was a capture, reset counter (capture breaks the king move sequence)
    if (state.move.capturedSquares && state.move.capturedSquares.length > 0) {
      break; 
    }
    
    // We need to know if the piece moved was a king.
    // If we only have the board before the move and the move, we can check the piece at `move.from` in the previous board state.
    // We assume history[i-1].board is the state before this move was applied.
    if (i > 0) {
      const prevBoard = history[i-1].board;
      const piece = prevBoard[state.move.from - 1];
      
      if (!isKing(piece)) {
        break; // A man moved, reset counter
      }
    }
    
    consecutiveKingMoves++;
  }
  
  // 25 moves = 50 plies (each player moved 25 times)
  return consecutiveKingMoves >= 50;
}

/**
 * Returns true if players are allowed to offer a draw.
 * Rule: 40 moves minimum per player (80 plies).
 */
export function canOfferDraw(moveCount) {
  return moveCount >= 80;
}
