# Draught Bet security fix plan

**Source:** `Security Audit/Draught_Bet_Security_Audit_2026-09-09.md` (18 findings, 10 reproduced unsafe behaviors).
**Validated against:** `refactor/backend-v2` at `64cd382`. All 18 findings confirmed against current source.
**Status:** Phase 1 (Containment) implemented and merged to `refactor/backend-v2` at `79a068d` — S03 (`268c233`), S13 (`ea9723f`), S12 (`79a068d`), plus test-mock fix `cd913be`. Phase 2 item 4 (S01) implemented at `0cca520` (guarded+idempotent withdrawals + DB constraints, real-PG integration tests pass); Phase 2 item 5 (S02+S16) implemented at `633332e` (atomic claim gate, fee snapshot, singular net payout, real-PG gate tests pass). Phase 3 item 6 (S04) implemented at `dffd96c` (match-room membership authorized before join, per-connection room budget, reconnect notification limited to ACTIVE participants). Phase 3 item 7 (S05) implemented at `575768f` (atomic claim with self-accept/tier/ban/active-match policy, distinct-player guard + schema CHECK, real-PG concurrency tests pass). Phase 3 item 8 (S06) implemented at `ada35a4` (ban/status enforced at refresh + socket auth + connection lifetime, admin ban/unban revokes sessions and drops sockets, logout disconnects sockets, Flutter account-switch socket teardown; access-token policy declared: stateless access lasts to natural expiry, realtime revoked at logout/ban). Phase 3 item 9 (S07) implemented at `2b3154a` (Lua GET+DEL consume so one token yields exactly one successor; reuse rejected; response-loss policy = retry as fresh login, no successor remembered; real-Redis+PG concurrency tests pass). Phase 3 item 10 (S09) implemented at `72735bb` (registration requires server-side geo evidence via a one-time binding token from `/auth/geo-locate`; the claimed DOB is persisted and `ageVerified` derived server-side; server-owned `Eligibility` record created atomically at registration; `assertEligibleForMoney` enforces country/age/KYC at withdrawal, matchmaking queue join, and match funding for both players — including the queued worker — via `debitStakes`/`createMatchWithStakes`/`acceptCallout`; returning 403; migration `20260915000000_eligibility`; Flutter threads the binding token geo-locate→register; real-PG KYC-block tests added). Phase 3 complete. Phase 4 item 11 (S10) implemented at `d34ad6d` (durable `GameOutbox` activation record committed in the same transaction as the stake reservations; `initializeGame` made idempotent so a crash after Redis init never clobbers a live game; `finalizeMatchActivation` + a recovery sweep replay or release each record exactly once — `GameOutboxStatus`, lease-token claim, stale-lease reclaim, release refunds both stakes once via the `(matchId, REFUND, walletId)` unique index; `MatchStatus.RELEASED`; worker/call-out no longer re-queue a funded pair; real-PG+Redis crash-window/stale-lease/release tests pass). Phase 4 item 12 (S11) implemented at `d2a515e` (fixes the broken `applyMove(...).newBoard` fallback by replaying the durable `MatchMove` log through the engine; `handleMoveAttempt` now persists each accepted move durably and uniquely keyed by `(matchId, moveNumber)` BEFORE the live projection advances — a DB write failure rejects without advancing state, a duplicate delivery is idempotent (already-applied) or resumes the apply of a persisted-but-unapplied move, and `move_applied`/`/state` carry `matchId` + version identity; `reconstructMoveHistory` is the recovery path for Redis loss or restart; `settleGame`/`settleGameDraw` refuse board-derived outcomes whose move log is empty — settlement cannot run from missing evidence; migration `20260917000000_durable_move_log`; default suite 163 passed/30 skipped, real-PG+Redis integration 30/30). Phase 4 item 13 (S15) implemented at `dd3f735` (active-match reservation enforced at the funding gate — `lockWalletForUpdate` pair + single ACTIVE `Match` row claimed inside `debitStakes`, so a player can never hold two active matches; settlement composes through the Phase-2 gate with compare-and-delete `user:<id>:activeMatch` guarded by match ID so cleanup never wipes a newer match's pointer; real-PG concurrency tests pass). Phase 4 item 14 (S14) implemented at `1d0764a` (shared Redis rate limiter built only after Redis readiness with distinct `rl:http:*` prefixes and fail-open memory fallback on outage; per-user/per-event socket budgets — `move_attempt` 60/min, `resign` 10/min, `join_match` 30/min, ≤5 sockets per user — enforced in a Lua INCR+PEXPIRE guard with `maxHttpBufferSize` 16 KB; bounded pagination default 20 / max 100 rejects oversized pages; callout fanout chunked and bounded; burst-throttle/oversize/connection-lifetime tests pass). Phase 4 item 15 (S18) implemented at `3283229` (authoritative `Match.timeControlSeconds` snapshot at funding from `PlatformSettings` (default 60s, migration `20260919000000_time_controls`); the game CAS script refuses any non-ending transition on an expired turn via authoritative Redis `TIME`, and a pre-persist expiry check keeps an expired move off the durable log; a 5s `turnDeadlineSweep` SCAN forfeits the player on the clock through the existing terminal settlement gate as `timeout_forfeit`; real-PG+Redis Lua-contract and end-to-end forfeit/payout tests pass). Phase 4 item 16 (S08) implemented at `2275fcd` (server-created `DepositIntent` persisted with reference/provider/amount/currency/wallet BEFORE any checkout is exposed; both gateways echo OUR reference (Paystack `reference` / Flutterwave `tx_ref`); `processDepositWebhook` verifies the event against the stored intent — unknown reference, gateway/user/amount (exact BigInt) /currency mismatch all reject with no credit, which is derived from `intent.amountMinorUnits`, never the webhook body; duplicate/concurrent deliveries are acknowledged via the unique `gatewayReference` index and `COMPLETED` check with no re-credit; floats eliminated via `parseMinorUnits`/`parseDecimalMajorToMinor` (+ exact integer-math minor→major); migration `20260920000000_payment_intents`; unit + real-PG intent tests pass). Phase 4 item 17 (S17) implemented at `581b0f2` (match-history projection drops player `email` entirely and returns only the public `username` handle in `playerLight`/`playerDark`; the Flutter results screen renders the handle with `Opponent` fallback; unit tests assert no `email`/raw-address leaks even for users without a handle). Re-validate findings against the new source before starting the next item.

## Validation summary (all findings confirmed)

| ID | Finding | Source evidence |
|---|---|---|
| S01 | Concurrent withdrawals can overdraw a wallet | `wallet/service.js:54-95` — balance read, unconditional decrement, no lock/guarded debit, no idempotency key |
| S02 | Settlement gate permits duplicate/conflicting payouts | `settlement.js:162-207,209-242` — reads ACTIVE then updates by ID without ACTIVE predicate; no unique ledger key; `settleGame` accepts outsider `winnerId` |
| S03 | Malformed socket event terminates Node | `gameManager.js:120,241`, `disconnectHandler.js:38` — param-list destructure; `index.js:41-50` has no rejection catch |
| S04 | Unauthorized match-room join and state disclosure | `disconnectHandler.js:38-67` — `join_match` joins room before membership check |
| S05 | Call-out acceptance bypasses policy, allows self-matches | `callout/service.js:98-149` — no self-accept rejection, no tier/ban revalidation; `matchService.debitStakes` can debit same wallet twice |
| S06 | Ban/logout/session lifetime inconsistent across HTTP and sockets | `auth/service.js:179-194` (refresh skips user lookup); `sockets/middleware.js:16-43` (JWT-verify only) |
| S07 | Refresh rotation not atomic | `auth/service.js:182-190` — separate GET then DEL |
| S08 | Deposits lack stored-intent and currency verification | `webhookController.js:29-41,86-99` — credits metadata user/amount; FP math at line 91 |
| S09 | Country and identity gates are client assertions | `auth/controller.js:37` (countryCode optional); `auth/service.js:61` `ageVerified: true` from claimed DOB; `kycStatus` never checked |
| S10 | Debits commit before recoverable game init | `callout/service.js:128-149` — `debitStakes` commits before `initializeGame` |
| S11 | Move audit durability and recovery unsafe | `match/controller.js:110` `board = applyMove(board, moveObj)` broken fallback; `persistMatchMove` not awaited |
| S12 | Compose publishes weakly protected data services | `docker-compose.yml` (5432/6379 all interfaces, `user/password`, Redis no password); `.env.example` sample JWT |
| S13 | Bearer credentials and sensitive data enter logs | `app.js:48-55` pino-http no redaction serializers; `auth/controller.js:119` logs raw lat/lng + result |
| S14 | Rate limiting weaker than comments claim | `middleware/rateLimit.js` store captured at module load → memory always; no socket budgets |
| S15 | Active-match and presence invariants not enforced | `matchmaking/controller.js:20` no active-match check; single `user:<id>:activeMatch` pointer overwritten and deleted unconditionally (`settlement.js:26-28,69-71`) |
| S16 | Commission accounting and fee terms inconsistent | `settlement.js:175-193` — commission from live settings; PAYOUT(net) + negative COMMISSION rows sum ≠ balance delta |
| S17 | Match history discloses opponents' emails | `match/controller.js:29-48` — selects and returns `email` |
| S18 | Connected players can stall indefinitely | `gameManager.js:99,158` — `lastMoveTs` recorded, never enforced |

## Phase 1 — Containment (stop the bleeding)

Blocker for serving real funds. Small, high-confidence changes.

### 1. S03 — Harden socket payload handling
- Validate every socket payload against a bounded schema (null/type/shape checks) inside `handleMoveAttempt`, `handleResign`, `handleJoinMatch` before param-list destructuring is relied upon.
- Wrap every async event handler in `sockets/index.js` with explicit rejection handling (try/catch around the `await`, or a shared wrapper) so no event can produce an unhandled rejection.
- Add per-user event budgets / payload limits (link to S14).
- **Acceptance:** null, omitted, array, oversized, invalid-ID, wrong-type payloads return a controlled `error`/`move_rejected` without terminating the server.

### 2. S13 — Redact credentials and sensitive data in logs
- Add redaction serializers to `backend/src/utils/logger.js` for authorization, bearer, cookie, token, password, key fields — at the root logger so pino-http and nested error objects inherit it.
- Remove raw `lat`/`lng`/geo-result logging in `auth/controller.js:119`; stop any FCM registration-token logging in `notification/service.js`.
- Review retention/access for already-written logs.
- **Acceptance:** a logged-in request with a synthetic bearer token produces a log line with the token redacted; a fixture fails if a synthetic secret survives serialization.

### 3. S12 — Hardening development Compose / env
- `docker-compose.yml`: bind PostgreSQL and Redis to `127.0.0.1` (or leave on a private network); set a Redis `requirepass`/ACL; replace sample `user/password`.
- Reject the known sample `JWT_SECRET` in production startup (add guard next to the existing "missing" checks).
- **Acceptance:** `docker-compose config` shows loopback-only or private-network bindings; prod boot refuses the sample secret; `nc -z <host> 5432` fails from outside.

## Phase 2 — Protect money

Requires real PostgreSQL race tests; mock suites insufficient per audit.

### 4. S01 — Guarded, idempotent withdrawals
- Replace read-then-decrement in `wallet/service.js:54-95` with a guarded debit whose affected-row count is checked (`where` includes `balanceMinorUnits >= amount`), or lock the wallet row before reading.
- Add unique user/operation idempotency key so retries cannot create duplicate requests.
- Add nonnegative-balance and positive-amount constraints in Prisma schema/migrations.
- **Acceptance:** real-Postgres concurrent withdrawal/withdrawal and withdrawal/stake tests never reserve more than available funds; replay returns the original operation.

### 5. S02 + S16 — One terminal settlement gate
- Persist accepted stake/fee snapshot on `Match` at funding time; validate winner/loser membership and reason before any write.
- Atomically claim the match in Postgres: conditional `updateMany where status='ACTIVE'` (or row lock) that returns affected rows.
- Unique ledger keys / unique (matchId, type, recipientWalletId) so duplicate financial entries are rejected.
- Use one consistent ledger convention (gross payout + fee debit, or net payout booked separately to platform); every balance change must reconcile to its signed entries.
- Route win, draw, resign, disconnect-sweep and reconciliation through the same gate.
- **Acceptance:** competing win/win, win/draw, resign/disconnect, sweep/direct tests produce exactly one outcome and one set of entries; outsider winners fail before writes.

## Phase 3 — Protect access

### 6. S04 — Authorize match room membership
- In `disconnectHandler.js` `joinMatch`: validate ID, fetch match, verify the socket user is a participant and the match is in an acceptable status before any room join or pointer cleanup.
- Limit per-connection rooms; only emit reconnection notifications for actual participants.
- **Acceptance:** a third account receives neither state nor room membership and cannot emit a false reconnection notification.

### 7. S05 — Call-out acceptance policy
- Reject identical light/dark player IDs in service and schema.
- Claim the callout and validate both users (tier, ban, active-match eligibility) and balances in one transaction with the stake reservation and match creation.
- **Acceptance:** self-accept, cross-tier accept, banned challenger and concurrent accepts have no unauthorized financial side effects.

### 8. S06 — Ban/logout/session consistency
- Validate account/session status (banned, still valid) during refresh and socket auth, not just on protected HTTP routes.
- Revoke/disconnect sessions on ban/logout; enforce connection lifetime; clear user-specific socket/provider state on account switch in the Flutter app.
- Declare access-token policy after logout and implement consistently.
- **Acceptance:** banned users cannot refresh or continue socket actions; logout/account switch cannot receive prior account events or send its actions.

### 9. S07 — Atomic refresh rotation
- Consume/rotate refresh tokens with Lua (GET + DEL + issue) or an equivalent transaction; maintain family revocation/reuse semantics.
- Decide response-loss behavior (e.g. remember issued successor).
- **Acceptance:** two simultaneous refreshes from the same token produce one valid successor; reuse of a consumed token is rejected.

### 10. S09 — Authoritative eligibility
- Server-owned eligibility record with evidence/status/provenance; persist the actual DOB and a geo proof binding.
- Enforce country, KYC and safer-play status at money/match entry, including worker execution after queuing.
- **Acceptance:** registration without country evidence cannot create an eligible player; withdrawal/match entry blocked without KYC status.

## Phase 4 — Recoverability, availability, payment contracts

### 11. S10 — Durable activation / outbox
- Model preparation vs activation: commit a durable game-start/outbox record with the reservations, initialize Redis idempotently, then mark activated; a recovery worker reconstructs or releases exactly once.
- Do not auto-replay a debit after ambiguous activation failure.
- **Acceptance:** crash injection after every DB/Redis boundary yields a playable match or a recorded release; no orphaned reservation, no second debit.
- **Status:** implemented at `d34ad6d`.

### 12. S11 — Durable accepted-move log + fallback repair
- Fix `match/controller.js:110` to use `applyMove(...).newBoard`.
- Persist accepted moves durably and uniquely keyed before (or atomically with) treating them as accepted; include match/version identity in game responses; make `(matchId, moveNumber)` unique.
- **Acceptance:** DB failure, Redis loss, duplicated delivery, restarts preserve one replayable history; settlement cannot run from missing evidence.
- **Status:** implemented at `d2a515e`.

### 13. S15 — Active-match and presence invariants
- Atomically reserve each participant for one active match; compare-and-delete `user:<id>:activeMatch` by match ID.
- Represent presence across all sockets/instances (shared adapter) if multi-instance is intended.
- Compose demand-settlement through the Phase-2 gate, not a second path.
- **Acceptance:** a user cannot hold two active matches; cleanup never deletes another match's pointer.
- **Status:** implemented at `dd3f735`.

### 14. S14 — Real rate limiting + budgets
- Initialize the shared limiter after Redis readiness with distinct key prefixes and explicit outage behavior.
- Add per-user/per-event socket budgets and connection/room quotas; bound all pagination.
- **Acceptance:** burst of socket events per user is throttled; oversized pages rejected.
- **Status:** implemented at `1d0764a`.

### 15. S18 — Turn deadlines
- Store authoritative time controls; check expiry atomically with every move; route deadline settlement through the terminal gate.
- **Acceptance:** a connected non-moving player forfeits after the deadline.
- **Status:** implemented at `3283229`.

### 16. S08 — Payment intent verification
- Persist server-created intents (reference, provider, amount, currency, wallet) before exposing checkout; verify successful webhooks against the stored intent; check wallet currency.
- Parse money without floating-point ambiguity (replace `Number(data.amount) * 100`).
- Return distinct already-applied result on duplicates; emit from a durable event record.
- **Acceptance:** correctly signed wrong-currency, wrong-user, wrong-amount, unknown-reference, duplicate events cannot create incorrect or repeated credit.
- **Status:** implemented at `2275fcd`.

### 17. S17 — Match history must not disclose opponents' emails
- Remove `email` from the match-history projection (`match/controller.js:31`); expose the opponent's public handle (`username`) instead, never the account email.
- Keep the current response shape (an `id` plus a displayable handle) so client rendering keeps working; update the Flutter results screen to render the handle.
- **Acceptance:** an authenticated player fetching their completed-match history receives every opponent as an ID + public handle and no `email` field anywhere in the response.
- **Status:** implemented at `581b0f2`.

## Closure evidence (per audit §"Repair order")

- Real PostgreSQL/Redis tests for S01/S02/S10/S11/S15 (concurrent clients, lost responses, restarts, ≥2 instances where applicable).
- New immutable commit per phase; deployed-version evidence recorded separately.
- Re-run full 60-test suite + `flutter analyze` + Frontend CI color-token check after each phase.