import { isKing, EMPTY } from './board.js';

/**
 * Checks if the current board state has occurred 3 times.
 * @param {Object} positionCounts - Map of position hash to count
 * @param {String} currentPositionHash - Hash of the current position
 */
export function isThreefoldRepetition(positionCounts, currentPositionHash) {
  // Wait, if it just reached 3, it's a draw.
  // Actually we just check if any value in positionCounts is >= 3.
  for (const key in positionCounts) {
    if (positionCounts[key] >= 3) {
      return true;
    }
  }
  return false;
}

/**
 * In International Draughts, if only kings are moving and no captures are made
 * for 25 consecutive moves (50 plies), it's a draw.
 * 
 * @param {Number} consecutiveKingMoves - Counter tracking consecutive king moves without capture
 */
export function isTwentyFiveKingMoveDraw(consecutiveKingMoves) {
  return consecutiveKingMoves >= 50;
}

/**
 * Returns true if players are allowed to offer a draw.
 * Rule: 40 moves minimum per player (80 plies).
 */
export function canOfferDraw(moveCount) {
  return moveCount >= 80;
}
