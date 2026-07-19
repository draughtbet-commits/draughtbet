import { 
  EMPTY, 
  WHITE_MAN, 
  WHITE_KING, 
  BLACK_MAN, 
  BLACK_KING, 
  COLOR_WHITE, 
  COLOR_BLACK,
  squareToRowCol, 
  getPieceColor,
  isKing
} from './board.js';

/**
 * Applies a move to the board and returns the new board state, 
 * along with information about captures and promotions.
 * 
 * @param {Array} board - The 1D board array
 * @param {Object} move - The move object with { from, to, path, capturedSquares }
 * @returns {Object} { newBoard, captured, promoted }
 */
export function applyMove(board, move) {
  const newBoard = [...board];
  const piece = newBoard[move.from - 1];
  const color = getPieceColor(piece);
  
  // 1. Move the piece
  newBoard[move.from - 1] = EMPTY;
  newBoard[move.to - 1] = piece;
  
  // 2. Remove captured pieces
  const capturedPieces = [];
  for (const sq of (move.capturedSquares || [])) {
    capturedPieces.push({ square: sq, piece: newBoard[sq - 1] });
    newBoard[sq - 1] = EMPTY;
  }
  
  // 3. Handle promotion
  let promoted = false;
  if (!isKing(piece)) {
    const { row } = squareToRowCol(move.to);
    if (color === COLOR_WHITE && row === 0) {
      newBoard[move.to - 1] = WHITE_KING;
      promoted = true;
    } else if (color === COLOR_BLACK && row === 9) {
      newBoard[move.to - 1] = BLACK_KING;
      promoted = true;
    }
  }
  
  return {
    newBoard,
    captured: capturedPieces,
    promoted
  };
}
