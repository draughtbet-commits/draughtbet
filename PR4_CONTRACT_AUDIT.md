# PR 4 — Pre-flight Contract Audit

Audited `2026-09-22` against backend `refactor/backend-v2` (local tree, current app `app/` on disk).
No changes were made to the frontend; this is a checklist to verify against the PR 4 branch (match lifecycle + stake reservation) when it arrives.

## Status

- PR 4 branch is NOT on remote yet (only `origin/ui/pr3-wallet-contract-fix` remains after `git fetch --prune`).
- Mapping doc: PR 4 = Match lifecycle + stake reservation, scope DB-MATCH-006..029.
- Everything below was verified against the backend source (source of truth).

## Verified OK (should still hold on PR 4)

- **REST paths align**: `/matches/history`, `/matches/:id/state`, `/callouts`, `/callouts/open`, `/callouts/:id/accept`, `/matchmaking/join|leave` (plural mounts in `backend/src/app.js`).
- **Callout contract**: `GET /callouts/open` returns `{id, challengerId, challenger:{displayName}, stakeMinorUnits(A string), tier, status, expiresAt}` — app `Callout.fromJson` parses it exactly.
- **Matchmaking**: `join/leave` sends `{stakeMinorUnits}`; bucket `queue:${tier}:${stakeMinorUnits}`; 409 on preterminal match; `match_found` emitted to both players' rooms; `callout_created` is broadcast to all so the app receives it.
- **Live game loop**: `move_applied` carries `board` (array), `nextTurn`, `legalMoves`, `gameEnded` — matches app `MoveAppliedEvent` handler; `match_ended` supplies win truth.
- **HTTP `GET /matches/:id/state`**: backend JSON-parses the board and adds `status`/`winnerId` → app model parses OK on this path.
- **Wallet**: `wallet_updated` (underscore) matches the outbox emit (verified live in PR 3).
- Log line `GET /open` = `/callouts/open` (HTTP logger prints the route pattern). Not an issue.

## Found — app-side issues to confirm/clear on PR 4

### 1. Reconnect/resync path will throw — `game_state` vs app model
- Backend on reconnect emits the raw Redis hash as `game_state` (`backend/src/sockets/disconnectHandler.js:128`): `board` is a JSON **string**, and there is **no `status` field**.
- App `GameState.fromJson` requires `board` as `List<int>` and `status` as non-null String (`app/lib/models/game_state.dart:8-20`, `app/lib/models/game_state.g.dart:10,14`) → `TypeError` on every reconnect mid-match.
- Backend also emits the **canonical** resync on `match.state` (`buildStatePayload`, `gameManager.js:91-95`) and comments "the app migrates to the latter" — **but the app does NOT listen to `match.state`** (only `game_state` is wired at `app/lib/services/socket_service.dart:84`).
- CHECK on PR 4: app subscribes `match.state` (and/or tolerates the legacy `game_state` board-as-string + missing `status`).

### 2. Dead `wallet.updated` (dot) listener
- `app/lib/services/socket_service.dart:143` listens to `wallet.updated` (dot). Backend emits only `wallet_updated` (underscore, line 142). Dot listener never fires — dead code.
- CHECK on PR 4: dot listener removed/renamed (no behavior change; underscore already works).

## UPDATE (2026-09-22, PR 4–8 pushed)

Citycod pushed 5 branches: `ui/pr4-pr8-contract-alignment`, `ui/pr5-settlement-ui`, `ui/pr6-deposit-ui`, `ui/pr7-withdrawal-ui`, `ui/pr8-game-protocol-ui`. `origin/refactor/backend-v2` advanced to `e363a72` (PR4 match UI).

### Branch topologies
- `refactor/backend-v2` @ `e363a72` = **origin** state. Contains `edac964` PR3 UI + `e363a72` PR4 UI. Lacks local V2 backend modules (`gameProtocol.js`, `outboxDrainer.js`, `matchmakingWorker.js`, etc.).
- **Local `backend/` = `refactor/backend-v2` @ `0883d38`, 25 commits AHEAD of origin** (gameProtocol, outbox, matchmaking, `match.state`, wallet projections, pr3-readflip…). Origin is 1 ahead (PR4 UI). This is what's deployed in the emulator.
- `ui/pr5…pr8` are a stacked chain on top of backend-v2; `ui/pr4-pr8-contract-alignment` is the WIP top: real contract wiring + socket changes + PR5–8 screens, +145 files / +10k lines.

### PR 4 as landed by citycod (`e363a72`)
- **Presentation-only**: `match_lifecycle_screens.dart` (722 lines) takes a prebuilt `MatchLifecycleSnapshot` and renders; `player_discovery_screens.dart`; no API calls, no socket use, no `WalletProvider` wiring. No contract bugs introduced; audit items 1–2 below untouched there (still latent).

### Real contract wiring is in `ui/pr4-pr8-contract-alignment`
- `services/socket_service.dart`: now listens `match.state` (feeds `_gameStateController` with `_protocolVersion=2`), `move.accepted` → `_moveAppliedController`, `move.rejected` → `_moveRejectedController`. New emitters `submitMoveV2` (`move.submit`), `resignV2` (`match.resign`), `offerDraw` (`draw.offer`), `respondToDraw` (`draw.respond`).
- `models/game_state.dart`: hardened normalizers (players/moveHistory/protocolVersion/stateVersion/sideToMove aliases); added protocol versioning.
- New gateways: `match_flow_gateway.dart` (GET `/callouts/open`), `settlement_gateway.dart`, `deposit_gateway.dart`, `withdrawal_gateway.dart` + recovery stores.

### Verified against the LOCAL (deployed) backend — `sockets/index.js` registers: `move.submit`, `move_attempt`, `match.resign`, `resign`, `match.join`, `join_match`, `clock.sync`, `disconnect`, `connection`; outbox emits `wallet_updated`; `gameManager.js:95` emits `match.state`.

### Alignment-branch socket contract findings (vs LOCAL backend = authoritative)
- **OK**: app emits `move.submit` ✓, `match.resign` ✓, `join_match` ✓ — all handled locally. App listens `move_applied`, `move.accepted`, `move.rejected`, `match.state`, `match_ended`, `match_ended_resign`, `opponent_*`, `notification`, `callout_created`, `wallet_updated` ✓.
- **A. Dead emitters (feature silently dead): `draw.offer` / `draw.respond`** — local backend registers NO `draw.*` inbound handler. `offerDraw`/`respondToDraw` in the alignment `socket_service.dart` will be dropped silently; match UI invoking them (PR8 draw flow) hangs.
- **B. Dead listeners (never fire on local backend): `draw.offer`, `draw.responded`, `match.finished`** — backend never emits these names.
- **C. Audit item 1 STILL PRESENT on the alignment branch**: backend still emits legacy `game_state` on reconnect (`disconnectHandler.js:128` = raw Redis hash → `board` JSON string, no `status`). Alignment `socket_service.dart` pushes BOTH `game_state` and `match.state` into the same `_gameStateController`; `GameState` still requires `List<int> board` + `String status` with **no default** in `_normalizeGameState` → `GameState.fromJson` throws for the legacy payload. Consumers must filter on protocolVersion. `match_provider.dart:182` onGameState is unguarded in all branches so far.
- **D. Audit item 2 STILL PRESENT**: `wallet.updated` (dot) dead listener still at `socket_service.dart:143`.

### Doc truth (citycod codes against the handoff docs; backend built to docs too)
Backend == docs. `docs/backend-handoffs/2026-09-17-game-protocol-v2.md` documents exactly what the local backend implements (`move.submit`, `move.accepted`, `move.rejected`, `match.state`, legacy `move_attempt`/`game_state`/`resign`/`join_match`). It contains NO draw events and NO `match.finished`. Therefore:
- Items 1–2 (`draw.offer`/`draw.respond` emitters, `draw.offer`/`draw.responded`/`match.finished` listeners): **not in any doc** — frontend invention; backend correctly omitted them.
- Item 3 (reconnect `game_state`): doc says `match.state` is the canonical resync and legacy `game_state` stays for the old client — frontend must consume `match.state`, still parses legacy.
- Item 4 (`wallet.updated` dot): caused by a **doc typo** — `2026-09-18-kyc-eligibility-safer-play.md:95` says `wallet.updated`; outbox doc + backend use `wallet_updated`. Backend followed the correct doc.

Verdict: frontend drifted from both its docs and the backend. Hand the four items back to citycod (fix app-side against the protocol doc + local backend); no backend change required.

### Open decision (RESOLVED: local is authoritative)
**Decision (user):** the **local `0883d38` backend is authoritative** for judging the frontend alignment branch. Origin `e363a72` lacks the V2 protocol modules and citycod's UI was coded against it; the local deployed kernel is the reference. Therefore findings A–D below are **real bugs**, not roadmap gaps (verified against `backend/src/sockets/index.js` local: `move.submit`, `match.resign`, `match.join`, `join_match`, `clock.sync`, `resign`, `move_attempt` are the only inbound handlers; no `draw.*` anywhere; no `match.finished`/`draw.*` emits).

## How to verify when the branch lands

1. `git fetch` + review in a temp worktree (PR 3 pattern); do NOT merge until approved.
2. Diff socket wiring against the two items above.
3. Run the branch's app test suite + `flutter analyze` on touched files; run its backend jest suites.
4. If untouched by PR 4, raise items 1–2 as blocking before merge and fix in the worktree.