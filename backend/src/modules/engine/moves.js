import { 
  EMPTY, 
  WHITE_MAN, 
  WHITE_KING, 
  BLACK_MAN, 
  BLACK_KING, 
  COLOR_WHITE, 
  COLOR_BLACK,
  squareToRowCol, 
  rowColToSquare, 
  getPieceColor,
  isKing
} from './board.js';

const DIRS = [
  { dr: -1, dc: -1 },
  { dr: -1, dc: 1 },
  { dr: 1, dc: -1 },
  { dr: 1, dc: 1 }
];

/**
 * Returns all legal moves for a given color on the given board.
 * Enforces the mandatory maximum capture rule.
 */
export function getLegalMoves(board, color) {
  const maxCaptures = getMaxCapturePaths(board, color);
  if (maxCaptures.length > 0) {
    return maxCaptures;
  }
  return getRegularMoves(board, color);
}

/**
 * Gets all non-capture moves for the given color.
 */
export function getRegularMoves(board, color) {
  const moves = [];
  
  for (let sq = 1; sq <= 50; sq++) {
    const piece = board[sq - 1];
    if (getPieceColor(piece) !== color) continue;
    
    const { row, col } = squareToRowCol(sq);
    const pieceIsKing = isKing(piece);
    
    for (const { dr, dc } of DIRS) {
      // Men can only move forward
      if (!pieceIsKing) {
        if (color === COLOR_WHITE && dr === 1) continue;
        if (color === COLOR_BLACK && dr === -1) continue;
      }
      
      let r = row + dr;
      let c = col + dc;
      
      while (true) {
        const targetSq = rowColToSquare(r, c);
        if (targetSq === null) break;
        
        if (board[targetSq - 1] !== EMPTY) {
          break; // Blocked
        }
        
        moves.push({
          from: sq,
          to: targetSq,
          path: [sq, targetSq],
          capturedSquares: []
        });
        
        if (!pieceIsKing) break; // Men only move one step
        
        r += dr;
        c += dc;
      }
    }
  }
  
  return moves;
}

/**
 * Gets all maximum capture sequences.
 */
export function getMaxCapturePaths(board, color) {
  let maxCapturedCount = 0;
  let bestPaths = [];
  
  for (let sq = 1; sq <= 50; sq++) {
    const piece = board[sq - 1];
    if (getPieceColor(piece) !== color) continue;
    
    const paths = getCapturePathsForSquare(board, color, sq);
    for (const path of paths) {
      const capCount = path.capturedSquares.length;
      if (capCount > maxCapturedCount) {
        maxCapturedCount = capCount;
        bestPaths = [path];
      } else if (capCount === maxCapturedCount && capCount > 0) {
        bestPaths.push(path);
      }
    }
  }
  
  return bestPaths;
}

/**
 * Finds all valid capture sequences originating from a specific square.
 */
function getCapturePathsForSquare(board, color, startSq) {
  const piece = board[startSq - 1];
  const pieceIsKing = isKing(piece);
  
  const results = [];
  
  // Backtracking function
  function search(sq, currentPath, capturedSquares) {
    let canCaptureMore = false;
    const { row, col } = squareToRowCol(sq);
    
    for (const { dr, dc } of DIRS) {
      let r = row + dr;
      let c = col + dc;
      
      // King can slide before capturing
      let foundEnemy = null;
      
      while (true) {
        const targetSq = rowColToSquare(r, c);
        if (targetSq === null) break;
        
        const targetPiece = board[targetSq - 1];
        
        if (targetPiece !== EMPTY) {
          // If we encounter our own piece or already captured piece, we can't jump it
          if (getPieceColor(targetPiece) === color || capturedSquares.includes(targetSq)) {
            break;
          }
          
          if (!foundEnemy) {
            foundEnemy = targetSq;
          } else {
            // Already found one enemy in this line, can't jump two adjacent enemies
            break; 
          }
        } else {
          // Empty square
          if (foundEnemy) {
            // We can land here!
            canCaptureMore = true;
            search(targetSq, [...currentPath, targetSq], [...capturedSquares, foundEnemy]);
            if (!pieceIsKing) break; // Men must land immediately after the captured piece
          }
        }
        
        if (!pieceIsKing && !foundEnemy) break; // Men can't slide
        
        r += dr;
        c += dc;
      }
    }
    
    // If no more captures can be made from this state, and we have captured at least one piece, save the path
    if (!canCaptureMore && capturedSquares.length > 0) {
      results.push({
        from: startSq,
        to: sq,
        path: currentPath,
        capturedSquares
      });
    }
  }
  
  search(startSq, [startSq], []);
  return results;
}
