/**
 * MatchService — V2 match lifecycle.
 *
 * Owns the match state machine, participants, commercial/game-term snapshots
 * and availability queries. It NEVER touches balances directly: every money
 * movement goes through StakeService (reserve/release) or, later, the
 * settlement flow. This module is dependency-light so every socket and job can
 * import its status constants without pulling in wallet code. Every function
 * takes the data client (a Prisma tx or the root client) explicitly.
 *
 * Status vocabulary (MatchStatus enum):
 *   PRETTERMINAL — a match that still occupies its players: DRAFT, OPEN,
 *                  FUNDED, READY, IN_PLAY, plus legacy ACTIVE.
 *   LIVE         — the running-game set: IN_PLAY (post-refactor) and the legacy
 *                  ACTIVE value that pre-refactor matches were created with.
 *   Terminal     — SETTLED, COMPLETED, FORFEITED, DISPUTED, CANCELLED, EXPIRED,
 *                  RELEASED (settlement keeps writing COMPLETED this PR).
 */

export const LIVE_STATUSES = Object.freeze(['ACTIVE', 'IN_PLAY']);

export const RESERVED_STATUSES = Object.freeze(['DRAFT', 'OPEN', 'FUNDED', 'READY']);

export const PRETTERMINAL_STATUSES = Object.freeze([
  'DRAFT',
  'OPEN',
  'FUNDED',
  'READY',
  'IN_PLAY',
  'ACTIVE'
]);

export class InvalidTransitionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidTransitionError';
  }
}

/**
 * Allowed state transitions. The map below covers the structured lifecycle:
 * funding, ready, start, and abandonment before start. Settlement claims its
 * own transition (LIVE -> SETTLED) atomically inside the settlement service.
 */
export const ALLOWED_TRANSITIONS = Object.freeze({
  DRAFT: ['OPEN', 'CANCELLED', 'EXPIRED'],
  OPEN: ['FUNDED', 'CANCELLED', 'EXPIRED'],
  FUNDED: ['READY', 'RELEASED', 'CANCELLED', 'EXPIRED'],
  READY: ['IN_PLAY', 'RELEASED', 'CANCELLED', 'EXPIRED'],
  IN_PLAY: ['SETTLED'],
  ACTIVE: []
});

export const isLiveStatus = (status) => LIVE_STATUSES.includes(status);

export const isPreterminalStatus = (status) => PRETTERMINAL_STATUSES.includes(status);

/**
 * Creates the canonical Match in OPEN state with both MatchParticipant rows
 * (LIGHT/DARK) and the frozen commercial/game-term snapshots. No balances are
 * touched here — funding/reservation is StakeService's job, which then moves
 * the match OPEN -> FUNDED.
 */
export async function createMatch(
  client,
  {
    matchId,
    playerLightId,
    playerDarkId,
    tier,
    stakeMinorUnits,
    commissionPercent,
    timeControlSeconds,
    currency
  }
) {
  return await client.match.create({
    data: {
      id: matchId,
      playerLightId,
      playerDarkId,
      tier,
      stakeMinorUnits,
      status: 'OPEN',
      settlementCommissionPercent: commissionPercent,
      timeControlSeconds,
      ...(currency !== undefined && currency !== null ? { currency } : {}),
      participants: {
        create: [
          { userId: playerLightId, side: 'LIGHT' },
          { userId: playerDarkId, side: 'DARK' }
        ]
      }
    }
  });
}

/**
 * Validated transition (throws on an illegal move). For use inside the callers'
 * transaction where the wallet locks serialize competing transitions.
 */
export async function transitionMatch(client, matchId, toStatus) {
  const current = await client.match.findUnique({
    where: { id: matchId },
    select: { status: true }
  });
  if (!current) throw new InvalidTransitionError(`Match not found: ${matchId}`);
  const allowed = ALLOWED_TRANSITIONS[current.status] ?? [];
  if (!allowed.includes(toStatus)) {
    throw new InvalidTransitionError(
      `Invalid match transition ${current.status} -> ${toStatus}`
    );
  }
  return await client.match.update({
    where: { id: matchId },
    data: { status: toStatus }
  });
}

/**
 * Idempotent CAS transition: advances the match only when its current status is
 * one of `fromStatuses`. Returns the number of rows updated (0 = not ours to
 * move). Used for the idempotent hooks (FUNDED -> READY on activation,
 * READY -> IN_PLAY on first live move) that may race a retrying actor.
 */
export async function transitionMatchWhere(client, matchId, fromStatuses, toStatus, extraData = {}) {
  const result = await client.match.updateMany({
    where: { id: matchId, status: { in: fromStatuses } },
    data: { status: toStatus, ...extraData }
  });
  return result.count;
}

/**
 * True when any of `playerIds` already holds a pre-terminal match. This is the
 * single choke point for "one game at a time": the queue-join guard, the
 * call-out accept guard, and the atomic funding re-check (inside the locked
 * wallet transaction) all use it, so a player can never be double-queued or
 * double-funded across those paths.
 */
export async function hasPreterminalMatchForPlayers(client, playerIds) {
  const row = await client.match.findFirst({
    where: {
      status: { in: PRETTERMINAL_STATUSES },
      OR: playerIds.flatMap((userId) => [
        { playerLightId: userId },
        { playerDarkId: userId }
      ])
    },
    select: { id: true }
  });
  return Boolean(row);
}

export default {
  LIVE_STATUSES,
  RESERVED_STATUSES,
  PRETTERMINAL_STATUSES,
  ALLOWED_TRANSITIONS,
  InvalidTransitionError,
  isLiveStatus,
  isPreterminalStatus,
  createMatch,
  transitionMatch,
  transitionMatchWhere,
  hasPreterminalMatchForPlayers
};