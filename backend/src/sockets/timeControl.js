// Shared time-control constants/helpers. The authoritative deadline for a live
// game lives in the Redis `match:<id>` hash (managed by the gameManager CAS
// script); these helpers compute the derived values the sweeps and handlers use.

export const DEFAULT_TIME_CONTROL_SECONDS = 60;

// Settlement endReason for a forfeit caused by an expired turn.
export const TURN_EXPIRED_REASON = 'timeout_forfeit';

/**
 * Absolute deadline (ms epoch) for a turn that started at `turnStartTs` with a
 * `tcSeconds` allowance. Returns null when the clock is disabled (0 / legacy).
 */
export const turnDeadlineAt = (turnStartTs, tcSeconds) => {
  const start = Number(turnStartTs);
  const allowance = Number(tcSeconds);
  if (!Number.isFinite(start) || start <= 0) return null;
  if (!Number.isFinite(allowance) || allowance <= 0) return null;
  return start + allowance * 1000;
};

/**
 * Whether a turn that started at `turnStartTs` has already expired. Strictly
 * uses a boundary-crossing comparison (now > deadline), matching the atomic
 * guard embedded in the gameManager CAS script.
 */
export const isTurnExpired = (turnStartTs, tcSeconds, now = Date.now()) => {
  const deadline = turnDeadlineAt(turnStartTs, tcSeconds);
  return deadline !== null && Number.isFinite(now) && now > deadline;
};