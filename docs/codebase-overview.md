# Codebase Overview — Draught Bet

Survey of the repository as it stands on branch `refactor/backend-v2`
(25 commits ahead of `origin/refactor/backend-v2`, HEAD `a4a0386`).

This is a read-only orientation document: a map of what exists, how it hangs
together, and where the friction is. It is not a plan and not a handoff.

## Scale

| Area | LOC |
|---|---|
| Backend source (`backend/src`, excl. tests) | ~18,700 |
| Backend tests | ~18,600 |
| Flutter lib (`app/lib`, excl. codegen) | ~21,000 |
| Flutter tests (`app/test` + `integration_test`) | ~9,400 |
| Prisma schema | 1,426 |

Test-to-source ratio is roughly 1:1 on the backend and 0.45:1 on the app.
87 backend test files (15 integration), 15 app unit/widget suites
(6 golden, 84 PNGs), 9 integration drive tests.

## What the product is

Contracted under working title "Draughts Arena", renamed **Draught Bet**
(permitted by the contract recitals without a separate amendment). Real-money
International Draughts (10x10, FMJD rules) on Android. Nigeria-first: NGN
wallet, Paystack primary / Flutterwave secondary. Contract DA-DEV-2025-001.

The governing documents at the repo root (`00_MASTER_PROMPT.md` through
`07_ENGINEERING_STANDARDS_AND_OPERATIONS.md`) define the non-negotiables.
The one that matters most structurally: **the server is the sole authority on
game state and money.** Both halves of the codebase honour that, and the
client half does so correctly by having no rules engine at all.

---

## Backend

Express 5 + Socket.IO + Prisma/Postgres 15 + Redis 7, ESM, Jest 30.

### Bootstrap split

`src/app.js` is deliberately side-effect-free; `src/server.js` is the only
file with top-level effects. Comment at `server.js:25-28` states the rule:
all background jobs start from the process bootstrap, never from importing
`app.js`. The 14 job starters and the SIGTERM/SIGINT shutdown path live there.

Middleware order in `app.js:41-148` is load-bearing, not incidental:

```
trust proxy -> helmet -> cors -> [TLS] -> requestId
  -> /webhooks          <-- mounted BEFORE express.json() for raw-body HMAC
  -> express.json() -> httpLogger -> globalRateLimiter
  -> /api/v1/* mounts -> /health -> /ready -> finalErrorHandler
```

Moving the webhook mount below `express.json()` silently destroys signature
verification. It is commented as such; leave it.

### Module shape

22 modules under `src/modules/`, near-universally `controller.js` (Express
only) -> `service.js` (domain logic) -> `__tests__/`. Controllers parse,
delegate, and map typed errors to status codes; they do not touch Prisma for
logic.

Error mapping is centralised rather than ad-hoc: `eligibility/service.js:31-51`
maps 19 error class names to HTTP codes, read via `EligibilityService.statusCode`.

### Game engine — verified pure

`src/modules/engine/`: `board.js`, `moves.js`, `apply.js`, `draws.js`,
`checkGameEnd.js`, `index.js`.

The import graph is only relative sibling imports. No Prisma, no Redis, no
network, no `Date.now()`, no env, no mutable module state. `applyMove` clones
before mutating. This is the one component in the repo that is provably
trivially testable, and it holds up.

50-element array (`board[sq-1]`, squares 1-50). `rowColToSquare` returns
`null` for light squares and out-of-bounds — the off-board sentinel the
whole capture search depends on. Rules implemented: men forward-only,
flying kings, mandatory maximum capture, multi-jump chains with men landing
immediately and kings allowed to slide, captured pieces blocking reuse,
promotion, and no-legal-moves loss.

### Real-time protocol

Socket.IO on the same HTTP server, `maxHttpBufferSize: 16 KiB`, a per-user
connection quota (`MAX_SOCKETS_PER_USER`, default 5) so the event budget
cannot be multiplied by reconnecting.

Every inbound event passes through `guardSocketHandler`
(`sockets/index.js:100-122`): token expiry, Redis fixed-window budget, and a
catch-all so no handler can surface as an unhandled rejection and kill the
process. All events are dual-named — a V2 name plus a legacy Flutter alias
(`move.submit` / `move_attempt`, etc.).

**Authoritative state** lives in a Redis hash `match:<id>` holding board,
turn, version, move counts, position counts, status, deadline, 24h TTL.

The concurrency core is `casScript` (`sockets/gameManager.js:30-68`) — one Lua
CAS that errors on missing game, errors `VERSION_MISMATCH` on stale version,
and **re-reads the Redis clock inside the script** to reject expired turns.
The same check exists in JS as a cheap pre-persist fast path; the in-script
guard is the race backstop. Ending transitions deliberately bypass the
deadline so the sweep can settle them.

Move idempotency is two-layered: a client-move-id lookup returns the prior
result for a replay, and a P2002 is disambiguated by checking whether the
colliding row carries *our* clientMoveId. `MatchMove` has unique
`(matchId, clientMoveId)` and `(matchId, moveNumber)`.

Rejections emit a stable error code **and** a full `match.state`, so a stale
client rebuilds deterministically rather than replaying a dead move.
`gameRecovery.js` rebuilds Redis from the durable `MatchMove` log and throws
if any stored move fails to replay — a loud corruption signal instead of
silent drift.

### Money invariants

- Signed `BigInt` minor units. Never floats. Decimal conversion is
  exact-string based.
- Double-entry ledger; every transaction balances; unique idempotency keys
  per reference.
- Ordered row locks (`lockWalletsInOrder` in `services/matchService.js`) to
  prevent deadlock.
- Wallet balance is a read-flip onto the ledger, not an incremental counter.
- Ledger and outbox rows commit **in the same transaction** as the state
  change that caused them.
- Notifications and admin actions are delivered at-least-once via a durable
  outbox, never inline push; `dedupeKey` makes replay a no-op. Stated
  explicitly in `notification/service.js:4-14` and `admin/service.js:5-9`.

### Security posture worth noting

- Refresh tokens stored as SHA-256 hashes only; rotation is a single Lua
  GETDEL so exactly one concurrent caller wins.
- Admin authorisation is DB-backed and re-read per request
  (`AdminRoleAssignments`), never JWT claims — so a role revoke binds across
  devices immediately.
- Admin router is a three-stage funnel: `requireAuth` -> `/mfa/*` bootstrap
  sub-router -> `requireAdminMfa` on everything else -> idempotency key.
- Player search uses a `PUBLIC_USER_SELECT` allowlist; email, phone, legal
  name, address, and credentials are excluded by construction.
- Webhook secret verification, `zod` validation, rate limiting with an
  explicit in-process fallback, pino with recursive secret redaction.

### Tests

Jest with no `jest.config.*` (defaults). `npm test` deliberately blanks
`DATABASE_URL` and `REDIS_URL` so unit tests can never touch real services.
Real-Postgres suites gate on `RUN_DB_INTEGRATION=1`. ESM mocking uses
`jest.unstable_mockModule()` + dynamic `import()`, which is the only way to
mock ESM bindings.

`sockets/__tests__/socketEvents.test.js` stands up a real HTTP + Socket.IO
server against mocked Prisma — genuine transport-level coverage rather than
handler-only unit tests.

Coverage is deepest exactly where the money and the concurrency are: 12
socket suites, 8 wallet/withdrawal suites, 12 job suites, 5 match suites.

---

## Flutter app

Riverpod, go_router, Dio, socket_io_client, freezed/json_serializable.

### Providers

11 files in `lib/providers/`, **all on the legacy `StateNotifierProvider`
API** — zero `Notifier`/`AsyncNotifier` classes. `settlementProvider` is
`autoDispose.family` keyed by `matchId`; the rest are process-lifetime.

Gates: `authProvider` -> API client + secure storage + socket.
`depositProvider` / `withdrawalProvider` -> their gateway + a recovery store.
`settlementProvider` reads `profileProvider` to filter receipts to the viewer.

### Routing

21 routes. `ShellRoute` holds the 13 bottom-nav routes; auth, money-in,
money-out, and match-flow routes sit outside the shell.

The auth guard is a `redirect` on a `GoRouter` with a `refreshListenable`
toggled by `ref.listen(authProvider)`. Logged out: `/landing`, `/login`,
`/register` pass, everything else -> `/login`. Logged in: those three ->
`/home`, everything else passes. Loop avoidance is a fixed point on both
sides — the redirect target is itself in the exemption set, so no
ping-pong is possible.

Two dispatcher widgets keep the pre-game flow flat despite ~12 distinct
terminal states: `_PrePlayLifecycleWatcher` at `/play/lifecycle/:matchId`
dispatches on `MatchFlowState.phase`, and `SentChallengeWatcher` does the
same for outgoing challenges.

### Networking

`api_client.dart` exposes one shared Dio with a single `AuthInterceptor`:
attach bearer token, on 401 mark-retried and perform **single-flight** token
refresh (concurrent 401s share one in-flight future, they do not each fire
their own), retry once, and on refresh failure clear credentials and publish
on `SessionExpiryBus`.

There is no global error interceptor by design. Each notifier maps
`DioException` status codes onto its own state, and
`config/backend_contract.dart` exposes a shared extractor that unwraps
`{error:{message}}`, `{message}`, and `detail` shapes so every screen
renders the same server text.

`backend_contract.dart` is the legacy/V2 switch (`BACKEND_CONTRACT`). It
provides version-gated path selection, `ClientRequestId.create()` for
idempotency keys, and `{success, data}` envelope unwrapping. The gateways
hold a per-operation idempotency key map: generated on first attempt,
attached, then removed on completion — a retry of the same logical operation
reuses it, a fresh operation gets a new one.

### Board

`lib/widgets/draught_board.dart` — 10x10, `CustomPaint`, tap-only gestures
(no drag), no internal state. Receives `selectedSquare` and `legalMoves`,
renders selection, legal destinations, and a visually distinct capture path.
`MatchScreen._onSquareTapped` looks the tapped index up in
`gameState.legalMoves` and emits `from`/`to`. **The client never validates a
move** — correct for anti-cheat, and it means every legal-move interaction
is a round trip. `inputEnabled: false` + `IgnorePointer` is how
`ResultBoardBackdrop` reuses it decoratively.

### Theming

`lib/theme/` centralises colour (`AppColors`) and type (`AppTypography`).
`google_fonts` is a dependency and is used throughout the screens, so the
theme is not purely `AppTypography`-driven; the static TTFs it needs are
bundled in `assets/fonts/google/`.

---

## Findings

Ordered by how much they cost if left alone.

### 1. `matchProvider` is declared twice

`lib/providers/match_flow_provider.dart` and `lib/providers/match_provider.dart`
both export `matchProvider`, for two different notifiers over two
incompatible state types. The app compiles and runs only because no file
imports both. Any screen that needs pre-game *and* in-game state — exactly
the lifecycle-to-match handoff — must import one and alias the other.

This is the highest-risk defect in the provider layer. It is a rename away
from breaking, and it will be hit by the next person who writes a screen
that spans both phases.

### 2. `google_fonts` can fetch fonts over HTTP at runtime

`GoogleFonts.config.allowRuntimeFetching` is never set to `false`. Every
weight the app currently uses is bundled locally, so the normal path is
fine — but any weight or family not present in `assets/fonts/google/`
triggers a network fetch. That makes golden tests and CI non-deterministic.

Compounding it: `tier_theme.dart:27` references raw `fontFamily: 'Manrope'`
and `callout_card.dart:125` references `'JetBrains Mono'`. Neither is
declared in `pubspec.yaml`, so both silently fall back to the platform
default and look inconsistent with the rest of the app.

### 3. Three backend modules have no tests at all

`modules/v2/`, `modules/risk/`, and `modules/support/` have no `__tests__`
directories. `v2` is the open-match lifecycle that the pre-game screens are
built against; `risk` is the admin risk surface. Both are reachable over HTTP.

### 4. Dead code in the app

| Item | Status |
|---|---|
| `lib/screens/wallet_screen.dart` | Orphan — no route, no importer |
| `WalletNotifier.requestWithdrawal` | Reachable only from the orphan above |
| `WalletNotifier.initiateDeposit` | Zero call sites |
| `lib/models/wallet_transaction.dart` (+codegen) | Orphan — no importers |
| `Wallet` class in `lib/models/wallet.dart` | Orphan class in a live file (file imported for `TierLimits` only) |
| `lib/services/fcm_service.dart` | Orphan — and contains no Firebase, despite the name |
| `lib/widgets/player_card.dart` | Orphan |

`wallet_screen.dart` must be deleted in the same change as
`requestWithdrawal`, since it is the only caller.

Also: three routes are wired but unreachable in-app — `/crown`,
`/results`, `/play/quick`. Reachable only by typing the URL.

### 5. Port mismatch between the app and its integration tests

`app/.env` sets `BACKEND_URL=http://10.0.2.2:3100/api/v1`.
`integration_test/home_active_drive_test.dart` hardcodes
`http://10.0.2.2:3000/api/v1` for its own seeding calls. Running the
integration suite with the shipped `.env` points the app at 3100 while the
test's seeding hits 3000.

### 6. Backend ops friction

No `start` script, no `lint` script, and no Node version pin (no `engines`
field, no `.nvmrc`). The `test` script is the only one that does anything
useful.

### 7. A hardcoded redirect URL in a real money flow

`modules/payment/FlutterwaveGateway.js:62` carries a hardcoded placeholder
redirect URL. This is a live payment path and should come from config
alongside the other gateway settings.

### 8. FCM is a stub at both ends

Backend: `jobs/outboxDrainer.js` logs `[MOCK FCM]` and sends nothing.
Frontend: `fcm_service.dart` contains no Firebase and is unreferenced.

Offline users get no push. The `firebase_messaging`, `firebase_core`, and
`flutter_local_notifications` dependencies are currently unused by any live
path. Either wire both ends or drop the dependencies — the current state
reads as "push works" and isn't.

### 9. Callout broadcast goes to everyone

`modules/callout/service.js` broadcasts call-outs to all users rather than
filtering by tier eligibility. The client's own definition of a call-out
does say all users get notified, so this may be intentional — but it is
worth confirming it isn't leaking stake amounts to ineligible players.

---

## On the threefold-repetition code

`engine/draws.js:8` reads as a live game-ending bug:

```js
export function isThreefoldRepetition(positionCounts, currentPositionHash) {
  // Wait, if it just reached 3, it's a draw.
  // Actually we just check if any value in positionCounts is >= 3.
  for (const key in positionCounts) {
    if (positionCounts[key] >= 3) return true;
  }
  return false;
}
```

It ignores its `currentPositionHash` parameter and returns true if *any*
count is `>= 3`, rather than checking the current position.

**It is not an active bug.** Both call sites increment the count *before*
invoking the check — `sockets/gameManager.js:576-580` and
`sockets/gameRecovery.js:55-56` — and the game terminates the moment any
count reaches 3, so no other count can exceed 2. In the well-formed flow
"any `>= 3`" and "current `=== 3`" are equivalent.

It is still worth tightening, because the correctness is entirely implicit:

- The function's contract is "caller must pre-increment," which is stated
  nowhere.
- The leftover `// Wait, if it just reached 3` commentary signals the author
  was unsure of this same question.
- `currentPositionHash` is dead, and so are the `isKing`/`EMPTY` imports.
- `engine.test.js:108-125` tests the shape (a map with a `3` in it) rather
  than the real path, so a future refactor that "fixes" the signature could
  break it without a test noticing.

The hardening is to make it explicit — drop the unused parameter, check the
current hash, and add a test that drives `checkGameEnd` the way the socket
layer actually calls it. Low severity, but it is in the one component the
project treats as highest-risk, and it currently rests on an unstated
invariant.

---

## Documentation drift

Worth knowing before trusting any progress file:

- `PROGRESS.md` still says "Week 10 (Admin Backend)" and was last updated
  2026-09-23, while git shows the PR7/PR8 withdrawal contract work landing
  afterwards.
- `progress.md` at the root is 38 KB and appears to be the earlier,
  longer-running log.
- There are three overlapping planning locations: the root `docs/` trackers,
  a parallel set inside `New Folder/` (including two "PR 14 Cutover" plans),
  and `docs/backend-handoffs/` (11 dated handoffs, the most current and
  clearly the live convention).
- `docs/backend-v2-pr-tracker.md` is explicitly marked as not tracked in git
  and names `New Folder/.../Draught_Bet_Backend_V2_Repo_Remediation_Plan.md`
  as authoritative.

The `docs/backend-handoffs/YYYY-MM-DD-topic.md` convention is the one to
follow for anything new. Its latest entry
(`2026-09-27-deposit-production-readiness.md`) is the most recent work.

`flutter/` at the repo root is the Flutter SDK itself, not project code.

---

## Running things

```sh
# Backend unit tests (integration suites auto-skip; DATABASE_URL/REDIS_URL
# are blanked by the script so nothing can touch real services)
cd backend && npm test

# Full battery including real Postgres + Redis
RUN_DB_INTEGRATION=1 RUN_REDIS_INTEGRATION=1 \
  node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --forceExit

# Flush stale match:* / user:*:activeMatch keys after integration runs.

# Flutter unit + widget + goldens
cd app && flutter test

# Regenerate goldens after an intentional visual change
flutter test --update-goldens test/wallet_read_visual_test.dart

# Integration (needs a live backend and a booted emulator/device)
flutter test integration_test/lifecycle_walkthrough_test.dart -d emulator-5554
```

`app/test/failures/` is Flutter's auto-generated golden diff output, not
source. It currently holds ~100 untracked PNGs, which means the visual suites
were failing when they were last run.
