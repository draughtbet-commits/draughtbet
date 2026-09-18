import { describe, it, expect, jest } from '@jest/globals';
import {
  MOVE_ERROR,
  buildStatePayload,
  emitMoveRejected,
  emitMoveAccepted,
  SIDE_BY_COLOR
} from '../gameProtocol.js';
import { createInitialBoard, COLOR_WHITE } from '../../modules/engine/index.js';

describe('gameProtocol', () => {
  it('exposes stable rejection codes', () => {
    expect(MOVE_ERROR.STALE_STATE).toBe('stale_state');
    expect(MOVE_ERROR.ILLEGAL_MOVE).toBe('illegal_move');
    expect(MOVE_ERROR.NOT_YOUR_TURN).toBe('not_your_turn');
    expect(MOVE_ERROR.PERSIST_FAILED).toBe('persist_failed');
  });

  it('maps engine colors to durable MatchSide values', () => {
    expect(SIDE_BY_COLOR.WHITE).toBe('LIGHT');
    expect(SIDE_BY_COLOR.BLACK).toBe('DARK');
  });

  it('builds a canonical resync payload with legal moves for a live game', () => {
    const board = createInitialBoard();
    const payload = buildStatePayload('m1', {
      player1: 'p1',
      player2: 'p2',
      board: JSON.stringify(board),
      currentTurn: COLOR_WHITE,
      currentTurnUserId: 'p1',
      status: 'in_progress',
      winnerId: '',
      moveCount: '3',
      version: '3',
      deadlineAt: '123456',
      timeControlSeconds: '60'
    });

    expect(payload).toMatchObject({
      matchId: 'm1',
      version: '3',
      currentTurn: 'WHITE',
      currentTurnUserId: 'p1',
      status: 'in_progress',
      winnerId: null,
      moveCount: 3,
      deadlineAt: 123456,
      timeControlSeconds: 60
    });
    expect(payload.board).toEqual(board);
    expect(payload.legalMoves.length).toBeGreaterThan(0);
  });

  it('omits legal moves once the game is no longer in progress', () => {
    const payload = buildStatePayload('m1', {
      board: JSON.stringify(createInitialBoard()),
      currentTurn: COLOR_WHITE,
      status: 'completed',
      winnerId: 'p1',
      moveCount: '1',
      version: '1'
    });
    expect(payload.legalMoves).toEqual([]);
  });

  it('returns null for a missing or corrupt state', () => {
    expect(buildStatePayload('m1', null)).toBeNull();
    expect(buildStatePayload('m1', { board: 'not-json' })).toBeNull();
  });

  it('emitMoveRejected emits the legacy and V2 shapes', () => {
    const socket = { emit: jest.fn() };
    emitMoveRejected(socket, MOVE_ERROR.STALE_STATE, { currentVersion: 4 });
    expect(socket.emit).toHaveBeenCalledWith('move_rejected', { reason: 'stale_state' });
    expect(socket.emit).toHaveBeenCalledWith('move.rejected', { code: 'stale_state', currentVersion: 4 });
  });

  it('emitMoveAccepted emits both room broadcasts with the idempotency echo', () => {
    const emit = jest.fn();
    const io = { to: jest.fn(() => ({ emit })) };
    emitMoveAccepted(io, 'm1', {
      clientMoveId: 'cm_12345678',
      move: {
        from: 32, to: 12, path: [32, 21, 12], captured: [27, 17], promoted: false,
        nextTurn: 'BLACK', ended: false, reason: null,
        legalMoves: [], newBoard: [], version: 2
      }
    });

    expect(io.to).toHaveBeenCalledWith('match:m1');
    const applied = emit.mock.calls.find(([e]) => e === 'move_applied')[1];
    expect(applied).toMatchObject({ matchId: 'm1', version: '2', from: 32, to: 12 });
    const accepted = emit.mock.calls.find(([e]) => e === 'move.accepted')[1];
    expect(accepted).toMatchObject({
      matchId: 'm1',
      clientMoveId: 'cm_12345678',
      version: '2',
      stateVersion: 2,
      replayed: false
    });
  });
});
