import { getLegalMoves } from '../modules/engine/index.js';
import { resolveDisconnectGraceMs, remainingMs } from './timeControl.js';

// Engine colors (WHITE/BLACK) and the durable MatchSide enum (LIGHT/DARK) do
// not share spelling; the durable projection needs the enum value.
const SIDE_BY_COLOR = Object.freeze({ WHITE: 'LIGHT', BLACK: 'DARK' });

/**
 * Stable move-rejection codes. The legacy Flutter client only knows the
 * `move_rejected` event with a `reason` string, so these double as the legacy
 * reasons. New clients read them from `move.rejected { code }`.
 */
export const MOVE_ERROR = Object.freeze({
  INVALID_PAYLOAD: 'invalid_payload',
  GAME_NOT_FOUND: 'game_already_ended',
  GAME_NOT_IN_PROGRESS: 'game_not_in_progress',
  NOT_YOUR_TURN: 'not_your_turn',
  ILLEGAL_MOVE: 'illegal_move',
  STALE_STATE: 'stale_state',
  DUPLICATE_MOVE: 'duplicate_move',
  TURN_EXPIRED: 'turn_expired',
  PERSIST_FAILED: 'persist_failed',
  NOT_AUTHORIZED: 'not_authorized',
  SERVER_BUSY: 'server_busy'
});

/**
 * Canonical resync payload. This is the single shape a client should trust to
 * rebuild its board: it is derived from the authoritative Redis projection and
 * carries the current state version, clock deadline and legal moves. Emitted as
 * `match.state` on join and alongside `move.rejected` whenever the client is
 * stale.
 */
export const buildStatePayload = (matchId, state, nowMs = null) => {
  if (!state) return null;
  let board;
  try {
    board = typeof state.board === 'string' ? JSON.parse(state.board) : state.board;
  } catch {
    return null;
  }
  const status = state.status || 'in_progress';
  const currentTurn = state.currentTurn;
  const deadlineAt = state.deadlineAt ? Number(state.deadlineAt) : null;
  const parsedNow = nowMs === null || nowMs === undefined || nowMs === '' ? NaN : Number(nowMs);
  const serverNowMs = Number.isFinite(parsedNow) ? parsedNow : null;
  return {
    matchId,
    version: String(state.version ?? '0'),
    board,
    currentTurn,
    currentTurnUserId: state.currentTurnUserId ?? null,
    status,
    winnerId: state.winnerId || null,
    moveCount: Number.parseInt(state.moveCount ?? '0', 10) || 0,
    deadlineAt,
    timeControlSeconds: state.timeControlSeconds ? Number(state.timeControlSeconds) : null,
    // Official clock; `serverNowMs`/`remainingMs` only when known.
    turnStartedAtServer: Number(state.turnStartedAtServer) > 0
      ? Number(state.turnStartedAtServer)
      : null,
    serverNowMs,
    remainingMs: serverNowMs === null ? null : remainingMs(deadlineAt, serverNowMs),
    disconnectGraceMs: resolveDisconnectGraceMs(state),
    legalMoves: status === 'in_progress' && currentTurn ? getLegalMoves(board, currentTurn) : []
  };
};

/**
 * Emits a move rejection in both the legacy and V2 shapes. The legacy
 * `move_rejected` payload is intentionally `{ reason }` only — the deployed
 * Flutter client matches it field-for-field.
 */
export const emitMoveRejected = (socket, code, extra = {}) => {
  socket.emit('move_rejected', { reason: code });
  socket.emit('move.rejected', { code, ...extra });
};

/**
 * Emits a successful move in both shapes. `move_applied` is the legacy
 * room broadcast; `move.accepted` is the V2 room broadcast and additionally
 * carries the clientIdempotency key. `replayed` marks a duplicate submission
 * whose result is being returned without re-applying it.
 */
export const emitMoveAccepted = (io, matchId, { move, replayed = false, clientMoveId = null, clock = null }) => {
  const {
    from, to, path, captured, promoted,
    nextTurn, ended, reason, legalMoves, newBoard, version
  } = move;
  const clockFields = clock
    ? {
        serverNowMs: clock.serverNowMs ?? null,
        turnStartedAtServer: clock.turnStartedAtServer ?? null,
        deadlineAt: clock.deadlineAt ?? null,
        remainingMs: clock.remainingMs ?? null
      }
    : {};

  // Legacy Flutter event — unchanged shape plus the new idempotency echo.
  io.to(`match:${matchId}`).emit('move_applied', {
    matchId,
    version: String(version),
    from, to,
    captured,
    promoted,
    nextTurn,
    gameEnded: ended,
    reason,
    legalMoves,
    board: newBoard,
    ...clockFields
  });

  io.to(`match:${matchId}`).emit('move.accepted', {
    matchId,
    clientMoveId,
    version: String(version),
    stateVersion: Number(version),
    move: { from, to, path, captured, promoted },
    nextTurn,
    gameEnded: ended,
    reason,
    legalMoves,
    board: newBoard,
    replayed,
    ...clockFields
  });
};

export { SIDE_BY_COLOR };
