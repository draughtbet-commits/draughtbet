# Backend handoff: Server clock + reconnect (PR 9)

Date: 2026-09-17
Branch: `refactor/backend-v2` (local only, not pushed)
Audience: frontend / Flutter live-game socket client

## Summary

The server clock is now the single source of truth for turn time. Every
authoritative payload carries `serverNowMs`, `turnStartedAtServer` and the
remaining time for the current turn; a new `clock.sync` request lets a client
measure skew and re-anchor its UI without ever sending its own clock as
authority. Disconnect grace is configurable and snapshotted per match, durable
connection evidence is recorded, and a restart rebuilds Redis straight from the
durable move log instead of trusting a possibly-stale projection.

**The legacy wire contract is preserved.** Existing events are unchanged in
shape; the new clock fields are additive and ignored by the deployed client.

## New client → server event: `clock.sync`

```jsonc
{ "matchId": "uuid", "clientSentAt": 1789690000123 }  // clientSentAt optional
```

`clientSentAt` is echoed back only so the client can compute a round-trip / skew
offset. The server never reads a client-provided "now" as authoritative.

## New server → client event: `clock.sync`

```jsonc
{
  "matchId": "uuid",
  "serverNowMs": 1789690000222,        // authoritative (Redis TIME)
  "clientSentAt": 1789690000123,        // echo, or null
  "version": "8",
  "status": "in_progress",
  "currentTurn": "WHITE",
  "currentTurnUserId": "uuid",
  "turnStartedAtServer": 1789689990000,
  "deadlineAt": 1789690050000,
  "timeControlSeconds": 300,
  "remainingMs": 49778
}
```

## Clock fields on existing events

`match.state` (join snapshot / resync) and `move.accepted` / `move_applied` now
also carry:

```jsonc
{
  "serverNowMs": 1789690000222,        // null when the emitter has no clock read
  "turnStartedAtServer": 1789689990000,
  "deadlineAt": 1789690050000,
  "remainingMs": 49778,                 // null when serverNowMs is null
  "disconnectGraceMs": 60000            // match.state only
}
```

`remainingMs` is always derived server-side as `deadlineAt - serverNowMs`
(floored at 0, `null` when either value is unknown). A client must render time
from these fields, never from its own device clock.

## Disconnect grace

- Configured with `DISCONNECT_GRACE_MS` (default `60000`, clamped to
  `5000..600000`).
- The effective value is snapshotted into the match projection at game start and
  used for the whole match, so changing the env var mid-match cannot shorten an
  already-running grace period.
- `opponent_disconnected` still carries `{ userId, gracePeriodMs }`; the warning
  notification text is derived from the same snapshotted value.

## Reconnect and restart recovery

- A socket `disconnect` starts the grace timer only when it was the user's
  **last** connected socket; closing a second tab does not warn the opponent or
  arm a forfeit.
- On `match.join` the live Redis projection is reconciled against the durable
  log (`MatchMove` + `MatchGameState`) before it is served. If Redis is missing
  or behind `stateVersion`, the board is replayed move-by-move from the durable
  log and the projection is rebuilt (with a fresh `deadlineAt` from the durable
  `turnStartedAt`). A log that does not replay cleanly is never projected.
- On boot, `startGameRecovery()` rehydrates live matches (`IN_PLAY`/`ACTIVE`),
  re-points `user:<id>:activeMatch`, and re-arms pending disconnect grace from
  scratch (a restart is treated as a server incident, not a player fault).
- Durable evidence: `MatchConnectionEvent` (`CONNECTED`/`DISCONNECTED`/
  `RECONNECTED`) and `GameEvent` rows (`DISCONNECT`, `FORFEIT`) are written
  best-effort and never block gameplay.

## Disconnect sweep

`disconnectSweep` runs every 10s, validates each expired entry against the
durable match status before acting, and settles through the normal settlement
service. Two players disconnected past grace produce a draw; one produces a
forfeit win for the connected player. Forfeits can be paused operationally with
`GAME_FORFEIT_SUSPENDED=true`.

## Verification

- `moveProtocol.test.js`: added `clock.sync` suite (authoritative server time,
  `clientSentAt` echo, non-participant and malformed-payload rejection).
- `timeControl.test.js`: grace config parsing/clamping, per-match snapshot
  precedence, and `remainingMs` edge cases.
- `gameProtocol.test.js`: clock + grace fields in `match.state`, `serverNowMs`
  fill-in, and clock propagation through `move.accepted`/`move_applied`.
- `disconnectHandler.test.js`: last-socket suppression, snapshotted grace, clock
  fields on the join snapshot, durable reconnect evidence.
- `gameRecovery.test.js` (new): reconcile serves live when current, rebuilds
  from durable when missing/stale, never projects an unreplayable log, and
  `recoverLiveGames` rehydrates projections, re-points participants and re-arms
  disconnects.
- Full battery green: **51 suites / 384 tests**, including the DB/Redis
  integration suites.

## Exit gate

Changing the phone clock cannot change the official timeout: the turn guard in
the atomic CAS script compares `deadlineAt` against Redis `TIME`, the pre-persist
check uses `authoritativeNowMs()` (Redis `TIME`), and every emitted clock value
is server-derived.

## Deep verification (post-commit)

A real Socket.IO + PostgreSQL + Redis harness,
`backend/scripts/verify/pr9-server-clock-reconnect.mjs` (18 probes), was run
against the running stack (P1-P18). It found one defect, fixed on top of
`214e260`:

1. **`recoverLiveGames` ordered live matches by a field that does not exist**
   (`Match.updatedAt`). The Prisma query was rejected at runtime, so boot
   recovery threw and never rehydrated a single projection or participant
   pointer — the exact restart path this PR is meant to guarantee. Fixed by
   ordering on `Match.createdAt`. A real-PostgreSQL integration test
   (`timeControl.integration.test.js`, "boot recovery rehydrates a live match
   from durable state") now exercises the unmocked query so the regression
   cannot return.

Results after the fix:

- `pr9-server-clock-reconnect.mjs` **18/18 probes passed**, including the exit
  gate (P5: a client claiming ten hours of turn time is still expired and
  forfeited by the server deadline), authoritative `clock.sync` (P3/P4), stale
  and missing projection reconcile (P6/P7), an un-replayable durable log never
  projected (P8), boot rehydrate/re-arm (P9/P10), last-socket grace (P11),
  reconnect clearing the timer with durable `RECONNECTED` evidence (P12),
  per-match pinned grace (P13), forfeit/draw/validity/suspension sweep
  decisions (P14-P17), and the closed-book ledger invariant (P18).
- Regression harnesses re-run green: pr3 9/9, pr5 10/10, pr6 16/16, pr7 22/22,
  pr8 18/18.
- Full battery green: **51 suites / 385 tests**.
