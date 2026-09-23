# Backend handoff: match status lifecycle (PR 4 states)

Date: 2026-09-15
Commit: `fda9f33` on `refactor/backend-v2` (not yet pushed to remote)
Audience: frontend / Citycod

## What changed

Matches are no longer created directly in `ACTIVE`. Funding a pair (via the
queue or a callout accept) now walks a state machine:

| status (DB) | status (API, lowercased) | meaning |
|-------------|--------------------------|---------|
| `OPEN`      | `open`                   | canonical Match row created, no money moved yet (transient) |
| `FUNDED`    | `funded`                 | both stakes reserved (StakeReservation rows + ledger LOCK) |
| `READY`     | `ready`                  | reserved for the upcoming both-players-confirm step (not produced yet) |
| `IN_PLAY`   | `in_play`                | **live match** — server-authoritative start (this replaces `active`) |
| `SETTLED` / `COMPLETED` | terminal states |
| `RELEASED` / `CANCELLED` / `EXPIRED` | money never-ran or aborted states |

`ACTIVE` is no longer produced by new code. Legacy `ACTIVE` rows are treated
as live for settlement/read purposes during the transition, but the app will
no longer see it on newly funded matches.

## What the frontend should do

- **Do not switch on `match.status === 'active'`** to decide a match is
  playable. Use `status === 'in_play'` (live) and, for "reserved / in a game"
  checks, treat `open`, `funded`, `ready`, `in_play` (and legacy `active`) as
  a match in progress.
- The live-match projection in Redis is unchanged (`match:{id}` hash with
  `status = 'in_progress'`), so gameplay flow, move submission, clocks, and
  settlement UX are unaffected.
- `open`/`funded` are transient windows (typically milliseconds). If the UI
  shows match status strings, it should be prepared to render them without
  treating them as errors, then flip to `in_play`.

## API surface

- `match/controller.js` still lowercases `match.status` on read; only the
  underlying enum values changed.
- No endpoint, socket event, or request/response shape changed in this PR.

## Relevant code

- `backend/src/modules/match/service.js` — status constants, transitions.
- `backend/src/modules/stake/service.js` — stake reservation/release.
- `backend/src/services/matchService.js` — `createMatchWithStakes` (OPEN→FUNDED).
- `backend/src/sockets/gameManager.js` — `initializeGame` performs the
  FUNDED/READY→IN_PLAY start.