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
- Full battery green: **40 unit suites / 301 tests + 10 integration suites / 60
  tests**; harnesses `pr3` 9/9, `pr5` 10/10, `pr6` 16/16, `pr7` 22/22.
