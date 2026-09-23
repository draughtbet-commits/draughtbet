# Backend handoff: Game protocol V2 (PR 8)

Date: 2026-09-17
Branch: `refactor/backend-v2` (local only, not pushed)
Audience: frontend / Flutter live-game socket client

## Summary

Move submission is now idempotent, staleness-gated and durably persisted. The
server accepts a client idempotency key (`clientMoveId`) and an expected state
version, and never applies the same move twice even under retries or concurrent
reconnects. Accepted moves are written to the durable move log (`MatchMove`) with
an audit `GameEvent` and a materialized `MatchGameState` projection in a single
database transaction before the client is told the move landed.

**The legacy wire contract is preserved.** The existing Flutter client keeps
working unchanged: it may keep emitting `move_attempt` and listening to
`move_applied` / `move_rejected` / `game_state`. `move_rejected` still carries
exactly `{ reason }` (the V2 error code doubles as the reason string).

## New client → server event: `move.submit`

```jsonc
{
  "matchId": "uuid",
  "clientMoveId": "c1a2b3c4",          // 8..64 chars [A-Za-z0-9_-], required
  "expectedStateVersion": 7,            // optional int >= 0
  "from": 32,
  "to": 12,
  "path": [32, 21, 12]                  // optional; full landing sequence
}
```

- `path`, when present, must start at `from`, end at `to`, and contain unique
  squares. It is validated against the engine's canonical capture path; a
  mismatch is rejected with `illegal_move` and `reason: "path_mismatch"`.
- `expectedStateVersion`, when present, is compared to the authoritative
  `match.state.version`. A mismatch rejects with `stale_state` and returns the
  canonical `match.state` so the client can resync and resubmit.
- The same event name is used for initial submission and retries. Retrying with
  the same `clientMoveId` replays the original result; it never applies twice.

## New server → client events

`move.accepted` (room broadcast, success):

```jsonc
{
  "matchId": "uuid",
  "clientMoveId": "c1a2b3c4",
  "version": "8",
  "stateVersion": 8,
  "move": { "from": 32, "to": 12, "path": [32,21,12], "captured": [], "promoted": false },
  "nextTurn": "BLACK",
  "gameEnded": false,
  "reason": null,
  "legalMoves": [ ... ],
  "board": [ ... ],
  "replayed": false                     // true when this was a duplicate replay
}
```

`move.rejected` (to the sender only):

```jsonc
{ "code": "stale_state", "expectedStateVersion": 3, "currentVersion": 8 }
```

Stable `code` values: `invalid_payload`, `game_already_ended`,
`game_not_in_progress`, `not_your_turn`, `illegal_move`, `stale_state`,
`duplicate_move`, `turn_expired`, `persist_failed`, `not_authorized`,
`server_busy`.

`match.state` (canonical resync / initial join snapshot):

```jsonc
{
  "matchId": "uuid",
  "version": "8",
  "board": [ ... ],
  "currentTurn": "WHITE",
  "currentTurnUserId": "uuid",
  "status": "in_progress",
  "winnerId": null,
  "moveCount": 8,
  "deadlineAt": 1789690000000,
  "timeControlSeconds": 300,
  "legalMoves": [ ... ]
}
```

`match.state` is emitted to the joining socket on `match.join` and alongside any
`stale_state` rejection.

## Legacy compatibility

- `move_attempt` { `matchId`, `from`, `to` } is unchanged and still accepted.
  It runs the same durable persistence and broadcasts `move_applied` with the
  identical field set, so the deployed app needs no change.
- `move_rejected` remains `{ reason }` only, field-for-field, because
  `socketEvents.test.js` pins it. The richer `{ code, ... }` payload is only on
  the new `move.rejected` event.
- Legacy aliases `resign` / `join_match` remain alongside `match.resign` /
  `match.join`.

## Durable persistence

`MatchMove` (unique on `(matchId, clientMoveId)` and on `(matchId, moveNumber)`),
a `GameEvent` of type `MOVE`, and the `MatchGameState` upsert are written in one
`prisma.$transaction`. The `MatchMove` unique insert serializes concurrent
submissions, so the following single-column `matchGameState.upsert` compiles
atomically and never raises `P2002`. A duplicate `clientMoveId` short-circuits
before the transaction (and is also caught via `P2002` as a backstop), replaying
the stored result to the sender only — no room broadcast.

## Verification

- `backend/src/sockets/__tests__/moveProtocol.test.js` (7 tests): persist
  `clientMoveId`/`path`/`stateVersion` + dual emit + settle once; `GameEvent` +
  `MatchGameState` in the same transaction; duplicate pre-check replay to sender
  only; `P2002` replay; stale version → `move.rejected { code: "stale_state",
  expectedStateVersion, currentVersion }` + `match.state`; path mismatch →
  `illegal_move`; invalid payload → `move.rejected { code: "invalid_payload" }`.
- `gameProtocol.test.js` (pure builders/emitters), extended `payloadGuard.test.js`,
  `gameFlow.test.js`, `durableMoveLog.test.js`.
- `durableMoveLog.integration.test.js` (real PostgreSQL + Redis): unique
  `(matchId, clientMoveId)`; `MatchMove` + `GameEvent` + `MatchGameState`
  persisted atomically through `move.submit`.
- Full battery green: **40 unit suites / 305 tests + 10 integration suites / 60
  tests**; harnesses `pr3` 9/9, `pr5` 10/10, `pr6` 16/16, `pr7` 22/22.

## Deep verification (post-commit)

A real Socket.IO + PostgreSQL + Redis harness,
`backend/scripts/verify/pr8-game-protocol.mjs` (18 probes), was run against the
running stack. It exercises the V2 accept/reject matrix, the durable log, the
replay-to-Redis path, concurrent races and the closed-book invariant. It found
two defects that were fixed on top of `f3feb69`:

1. **`ReferenceError` in the `submitMove` catch path.** The authoritative
   `state` was declared with `const` inside the `try`, but referenced by the
   `catch` branches (`server_busy` after exhausted `VERSION_MISMATCH` retries,
   `game_not_found`, `turn_expired`). Any of those produced an uncaught
   `ReferenceError` and a generic socket `error` instead of a rejection — a
   turn-expired race did not forfeit. Fixed by hoisting `let state = null;`
   above the `try` and assigning `state = await getGameState(matchId)`.

2. **P2002 could not distinguish a replay from a lost race.** On a unique
   violation the handler treated the submission as an accepted replay. A
   competing move that already held this `moveNumber` was therefore falsely
   reported as accepted (`replayed: true`) even though it was never applied,
   letting the client diverge from Redis. Fixed with `resolveUniqueConflict()`
   (look up by `matchId_clientMoveId`, else by `matchId_moveNumber`) plus a
   `sameMove` check: a colliding row that is not this exact move is refused with
   `duplicate_move` and a canonical resync.

The P12 probe was proven sensitive by temporarily reverting the `sameMove` guard
(`if (false && !sameMove)`) — P12 failed with "a competing loser must not be
replayed as accepted", then passed again once restored.

Results after the fixes:

- `pr8-game-protocol.mjs` **18/18 probes passed** (P1-P18), including P11
  concurrent duplicate applies exactly once, P12 concurrent different moves →
  one winner + refused loser with a log that replays to the live board, and
  P13/P14 full-capture path refused when truncated and stored verbatim when
  correct.
- `moveProtocol.test.js` now **11 tests** (added regressions for both defects:
  `server_busy`/`game_not_found`/`turn_expired` no longer `ReferenceError`, and
  a competing `moveNumber` is refused rather than replayed).
- Full battery green: **50 suites / 365 tests**; harnesses `pr3` 9/9, `pr5`
  10/10, `pr6` 16/16, `pr7` 22/22, `pr8` 18/18.
