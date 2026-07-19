export const EMPTY = 0;
export const WHITE_MAN = 1;
export const WHITE_KING = 2;
export const BLACK_MAN = 3;
export const BLACK_KING = 4;

export const COLOR_WHITE = 'WHITE';
export const COLOR_BLACK = 'BLACK';

/**
 * Converts a standard 1-50 square number to { row, col } (0-indexed).
 * Returns null if the square is out of bounds.
 */
export function squareToRowCol(square) {
  if (square < 1 || square > 50) return null;
  const row = Math.floor((square - 1) / 5);
  const col = ((square - 1) % 5) * 2 + ((row + 1) % 2);
  return { row, col };
}

/**
 * Converts a { row, col } (0-indexed) to standard 1-50 square number.
 * Returns null if out of bounds or if it's a light square (unplayable).
 */
export function rowColToSquare(row, col) {
  if (row < 0 || row > 9 || col < 0 || col > 9) return null;
  if (row % 2 === col % 2) return null; // Light square
  return row * 5 + Math.floor(col / 2) + 1;
}

/**
 * Creates the initial board state.
 * Returns an array of 50 elements (index 0 to 49 corresponds to squares 1 to 50).
 */
export function createInitialBoard() {
  const board = new Array(50).fill(EMPTY);
  // Black men on 1-20
  for (let i = 0; i < 20; i++) board[i] = BLACK_MAN;
  // White men on 31-50
  for (let i = 30; i < 50; i++) board[i] = WHITE_MAN;
  return board;
}

export function getPieceColor(piece) {
  if (piece === WHITE_MAN || piece === WHITE_KING) return COLOR_WHITE;
  if (piece === BLACK_MAN || piece === BLACK_KING) return COLOR_BLACK;
  return null;
}

export function isKing(piece) {
  return piece === WHITE_KING || piece === BLACK_KING;
}
