import {
  DEFAULT_TIME_CONTROL_SECONDS,
  TURN_EXPIRED_REASON,
  turnDeadlineAt,
  isTurnExpired
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
});