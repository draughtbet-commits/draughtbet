// Shared time-control constants/helpers. The authoritative deadline for a live
// game lives in the Redis `match:<id>` hash (managed by the gameManager CAS
// script); these helpers compute the derived values the sweeps and handlers use.

export const DEFAULT_TIME_CONTROL_SECONDS = 60;

// Settlement endReason for a forfeit caused by an expired turn.
export const TURN_EXPIRED_REASON = 'timeout_forfeit';

// Disconnect grace defaults/band; per-match snapshot overrides the env value.
export const DEFAULT_DISCONNECT_GRACE_MS = 60 * 1000;
export const MIN_DISCONNECT_GRACE_MS = 5 * 1000;
export const MAX_DISCONNECT_GRACE_MS = 10 * 60 * 1000;

const clampGrace = (value) =>
  Math.min(MAX_DISCONNECT_GRACE_MS, Math.max(MIN_DISCONNECT_GRACE_MS, Math.floor(value)));

// Configured grace (env `DISCONNECT_GRACE_MS`), clamped.
export const disconnectGraceMs = (env = process.env) => {
  const raw = Number(env.DISCONNECT_GRACE_MS);
  if (Number.isFinite(raw) && raw > 0) return clampGrace(raw);
  return DEFAULT_DISCONNECT_GRACE_MS;
};

// Per-match snapshot wins; legacy games fall back to the configured default.
export const resolveDisconnectGraceMs = (state, env = process.env) => {
  const snap = Number(state && state.disconnectGraceMs);
  if (Number.isFinite(snap) && snap > 0) return clampGrace(snap);
  return disconnectGraceMs(env);
};

// Official remaining time from a server deadline; null when clock disabled.
export const remainingMs = (deadlineAt, nowMs) => {
  const deadline = Number(deadlineAt);
  if (!Number.isFinite(deadline) || deadline <= 0) return null;
  const now = Number(nowMs);
  if (!Number.isFinite(now)) return null;
  return Math.max(0, deadline - now);
};

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