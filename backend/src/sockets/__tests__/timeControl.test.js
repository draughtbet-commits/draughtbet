import {
  DEFAULT_TIME_CONTROL_SECONDS,
  TURN_EXPIRED_REASON,
  DEFAULT_DISCONNECT_GRACE_MS,
  MIN_DISCONNECT_GRACE_MS,
  MAX_DISCONNECT_GRACE_MS,
  turnDeadlineAt,
  isTurnExpired,
  disconnectGraceMs,
  resolveDisconnectGraceMs,
  remainingMs
} from '../timeControl.js';

describe('timeControl', () => {
  it('exposes the platform default and the timeout settlement reason', () => {
    expect(DEFAULT_TIME_CONTROL_SECONDS).toBe(60);
    expect(TURN_EXPIRED_REASON).toBe('timeout_forfeit');
  });

  it('computes an absolute deadline from the turn start and allowance', () => {
    expect(turnDeadlineAt(1000, 60)).toBe(61000);
    expect(turnDeadlineAt(0, 60)).toBeNull();
  });

  it('treats a disabled or absent clock as no deadline', () => {
    expect(turnDeadlineAt(1000, 0)).toBeNull();
    expect(turnDeadlineAt(1000, -5)).toBeNull();
    expect(turnDeadlineAt(null, 60)).toBeNull();
    expect(turnDeadlineAt(undefined, 60)).toBeNull();
  });

  it('is expired only strictly after the deadline boundary', () => {
    const start = 1000;
    const now = turnDeadlineAt(start, 60);
    expect(isTurnExpired(start, 60, now)).toBe(false);
    expect(isTurnExpired(start, 60, now + 1)).toBe(true);
    expect(isTurnExpired(1000, 0, now + 100000)).toBe(false);
  });

  it('reads the configured disconnect grace with a clamped band', () => {
    expect(DEFAULT_DISCONNECT_GRACE_MS).toBe(60000);
    expect(disconnectGraceMs({})).toBe(60000);
    expect(disconnectGraceMs({ DISCONNECT_GRACE_MS: '90000' })).toBe(90000);
    expect(disconnectGraceMs({ DISCONNECT_GRACE_MS: '1' })).toBe(MIN_DISCONNECT_GRACE_MS);
    expect(disconnectGraceMs({ DISCONNECT_GRACE_MS: '99999999' })).toBe(MAX_DISCONNECT_GRACE_MS);
    expect(disconnectGraceMs({ DISCONNECT_GRACE_MS: 'not-a-number' })).toBe(60000);
  });

  it('prefers the per-match grace snapshot over the configured default', () => {
    expect(resolveDisconnectGraceMs({ disconnectGraceMs: '45000' }, { DISCONNECT_GRACE_MS: '90000' }))
      .toBe(45000);
    expect(resolveDisconnectGraceMs({}, { DISCONNECT_GRACE_MS: '90000' })).toBe(90000);
  });

  it('computes remaining time from a server deadline only', () => {
    expect(remainingMs(5000, 2000)).toBe(3000);
    expect(remainingMs(2000, 5000)).toBe(0);
    expect(remainingMs('', 5000)).toBeNull();
    expect(remainingMs(5000, NaN)).toBeNull();
  });
});