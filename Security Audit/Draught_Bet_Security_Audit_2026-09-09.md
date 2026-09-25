# Draught Bet security audit

**Date:** 9 September 2026  
**Repository:** https://github.com/draughtbet-commits/draughtbet  
**Revision:** `bbb191ac5ba4176578fb54e0e7456ca3cb23feb0` (`origin/main`, fetched for this audit). The fetched backend-v2 branch has the same tree.  
**Assessment:** The audited revision is not ready for real-money production use. Critical balance and settlement invariants remain unenforced, alongside remotely reachable authorization and availability defects.

## Scope and evidence limits

Reviewed the backend HTTP controllers, authentication, Socket.IO handlers, engine integration, wallet/payment services, matchmaking, scheduled jobs, Prisma schema/migrations, Flutter authentication/payment/reconnect code, deployment configuration and CI. The repository contains 283 tracked files; generated images/platform scaffolding were not treated as application security code. The audit used an isolated detached worktree, leaving the original checkout and remote repository unchanged.

The existing test suite passed: **14 suites, 60 tests**, with **48.74% statement coverage** and **44.41% branch coverage**. An additional audit suite reproduced **10 unsafe behaviors** using actual application functions with mocked external dependencies. These tests deliberately assert the vulnerable behavior; their passing does not mean the application is secure. Balance and settlement reproductions use controlled overlapping reads, not a running PostgreSQL instance. A separate real local Socket.IO connection reproduced a Node process crash (exit code 1). A local pino-http experiment confirmed that bearer authorization values are logged.

No production traffic, real credentials, real payments or live game sessions were used. PostgreSQL/Redis integration tests, Flutter builds, deployed APK examination, VPS firewall/TLS inspection, GitHub account settings and payment-dashboard configuration were not performed. Dependencies were reused from the existing local installation; a fresh locked installation was not performed. Dependency advisories were separately queried against the committed lockfiles. Findings below distinguish static evidence, controlled reproduction and deployment-dependent exposure.

## Findings at a glance

| ID | Severity | Finding | Evidence |
|---|---|---|---|
| S01 | Critical | Concurrent withdrawals can overdraw a wallet | Controlled reproduction + source |
| S02 | Critical | Settlement gate permits duplicate/conflicting payouts | Controlled reproduction + source |
| S03 | High | Malformed authenticated socket event terminates Node | Real local Socket.IO reproduction |
| S04 | High | Match room/state access lacks membership authorization | Controlled reproduction |
| S05 | High | Call-out acceptance bypasses tier rules and permits self-matches | Controlled reproduction + source |
| S06 | High | Banned users can refresh credentials and authenticate sockets | Controlled reproduction + source |
| S07 | Medium | Refresh-token rotation is not atomic | Controlled reproduction |
| S08 | High | Deposits lack stored-intent and currency verification | Signed fixture through HTTP router |
| S09 | High | Geographic and identity gates are not authoritative | Controlled reproduction + source |
| S10 | High | Postgres-to-Redis failures strand debited stakes | Source tracing |
| S11 | High | Move audit durability and recovery are unsafe | Source tracing |
| S12 | High, conditional | Compose publishes weakly protected data services | Configuration; deployment unverified |
| S13 | High | HTTP logs contain bearer credentials | Local logging reproduction + source |
| S14 | Medium | Distributed rate limiting silently uses memory; socket events lack budgets | Source tracing |
| S15 | High | Multiple active matches and unsafe presence cleanup | Source tracing |
| S16 | Medium | Commission accounting and accepted fee terms are inconsistent | Source arithmetic |
| S17 | Medium | Match history discloses opponents' email addresses | Source tracing |
| S18 | Medium | Connected players can stall indefinitely without server clocks | Source tracing |

Severity reflects impact in this real-money application, not a calculated CVSS score. Dependency advisory counts are separate from these 18 application/configuration findings.

## S01 — Concurrent withdrawals can overdraw a wallet

**Location:** `backend/src/modules/wallet/service.js:54-93`; `backend/src/modules/wallet/controller.js:120-140`; `backend/prisma/schema.prisma` Wallet/WithdrawalRequest models. **CWE-362 / CWE-841.**

`requestWithdrawal` reads a balance, compares it with the amount, then performs an unconditional decrement inside a transaction. The read does not lock the wallet and the decrement has no `balance >= amount` predicate. Under ordinary PostgreSQL READ COMMITTED isolation, two transactions can both read the old balance before either updates it. Serializing the UPDATE statements alone does not re-run the application check. No nonnegative-balance CHECK constraint exists in the committed migrations.

The controlled reproduction starts with 100 minor units and overlaps two withdrawals of 80. Both create a pending withdrawal and the balance becomes -60. The same race is relevant when a withdrawal overlaps a stake debit: the withdrawal read is not protected by the stake service's row-lock discipline. The endpoint also lacks a request idempotency key, so retries can create separate requests even when there is enough balance.

**Impact:** Unfunded withdrawal liabilities and corrupted balances. An external bank cash-out was not demonstrated because a complete payout execution path is absent.

**Fix:** Use a guarded debit with affected-row count, or lock the wallet before reading it; record the reservation and withdrawal operation in the same transaction. Add nonnegative-balance and positive-amount constraints and a unique user/operation idempotency key. Use a canonical bounded decimal-integer string contract for money.

**Acceptance:** Real PostgreSQL concurrent withdrawal/withdrawal and withdrawal/stake tests must demonstrate that total reserved funds never exceed available funds and replay returns the original operation.

## S02 — Settlement is not idempotent under concurrency

**Location:** `backend/src/sockets/settlement.js:162-241`; `backend/src/jobs/disconnectSweep.js:20-55`; `backend/src/jobs/reconciliationSweep.js`; WalletTransaction schema. **CWE-362 / CWE-841.**

Both win and draw settlement read ACTIVE status, then update by ID without an ACTIVE predicate or a prior match-row lock. Concurrent callers can pass the read gate and independently credit payouts/refunds. There is no unique settlement record or match/type/recipient constraint preventing duplicate financial entries. The Redis move CAS does not protect database-only disconnect settlement or competing reconciliation workers.

The controlled win reproduction credits 360 minor units for a 200-unit pot whose intended net payout is 180. A second reproduction shows that `settleGame` accepts an outsider as `winnerId` and looks up that outsider's wallet: it does not validate participants or an authoritative terminal outcome. This is an internal-service integrity gap; there is no demonstrated HTTP endpoint that directly accepts an arbitrary winner.

Disconnect settlement also does not claim a terminal Redis version before settling. A reconnect or terminal move can race the sweep's presence check. A result may therefore conflict even after the duplicate-credit bug alone is fixed.

**Fix:** Persist one authorized terminal result/version, then atomically claim one settlement in PostgreSQL. Validate winner membership and reason, lock/conditionally update the match, and commit ledger entries plus an outbox event together. Unique operation/entry keys must reject duplicates. All terminal paths must use the same finalization protocol. Retry wrappers are not a substitute for a conditional commit.

**Trade-off:** PostgreSQL row locks/conditional updates belong around money and settlement. Redis Lua is useful for move ordering/presence, but cannot atomically commit a PostgreSQL payout. A distributed lock alone is insufficient after lease expiry or process failure.

**Acceptance:** Competing win/win, win/draw, resign/disconnect and sweep/direct-settlement tests produce exactly one accepted outcome and one set of financial entries. Outsider winners fail before any writes.

## S03 — Malformed socket packet crashes the server

**Location:** `backend/src/sockets/index.js:41-50`; `gameManager.js:120,241`; `disconnectHandler.js:38`. **CWE-20 / CWE-248.**

The handlers destructure payloads in their parameter lists. A null payload throws before their internal try/catch starts. The registered async event callbacks do not catch the resulting rejection. With Node 24's default rejection behavior, it terminates the process.

**Verified:** A real local Socket.IO client authenticated with a synthetic test JWT and emitted `move_attempt` with null. Node exited 1 with `TypeError: Cannot destructure property 'matchId' ... as it is null`. The fixture does not require a live database or Redis because failure occurs first. Production reachability requires a valid account/token; registration is available.

**Fix:** Validate an unknown payload against a bounded schema before destructuring; wrap every async event handler with explicit rejection handling and a consistent acknowledgement. Add per-user event budgets and payload limits. Do not merely suppress process-level unhandled rejections.

**Acceptance:** Null, omitted, array, oversized, invalid-ID and wrong-type payloads return a controlled rejection without terminating the server.

## S04 — Unauthorized match-room join and state disclosure

**Location:** `backend/src/sockets/disconnectHandler.js:38-67`. **CWE-862 / CWE-639.**

`join_match` removes a disconnect entry and joins the requested room before fetching state. It never verifies that the authenticated user is either participant. It then returns the state and broadcasts an opponent-reconnected event. A caller can remain in an arbitrary room even if state lookup fails.

The audit fixture used an outsider and confirmed both room membership and receipt of `game_state`. HTTP `GET /matches/:id/state` correctly checks membership, but that protection does not apply to the socket route. Knowledge of a match ID is a prerequisite; UUID unpredictability does not provide authorization.

**Fix:** Validate the ID, fetch the match, authorize membership and permitted status before any room/presence mutation. Limit rooms per connection and ensure reconnection notifications only describe actual participants.

**Acceptance:** A third account receives neither state nor room membership and cannot emit a false reconnection notification.

## S05 — Call-out acceptance bypasses policy and allows self-matches

**Location:** `backend/src/modules/callout/controller.js` accept route; `service.js:98-149`; `backend/src/services/matchService.js:21-84`. **CWE-862 / CWE-841.**

Creation checks tier limits, but acceptance applies only `requireAuth`. The service does not reject the challenger accepting their own call-out, revalidate either player's tier/ban state, or check active-match eligibility. The open-list filter is not an authorization control; call-out IDs are also broadcast to all connected users.

The self-accept reproduction reaches a match with identical light/dark player IDs and debits the same wallet twice. With an 80-unit stake and 100-unit wallet, both reads see 100 and each debit takes 80. Ordered wallet locking does not solve the case where both IDs identify the same wallet.

**Fix:** Reject identical participants at the service and schema levels. Claim the call-out, validate both users and balances, reserve both stakes and create the match in one database transaction. Enforce tier/eligibility on acceptance, regardless of list filtering.

**Acceptance:** Self-accept, cross-tier accept, banned challenger and concurrent accept attempts have no unauthorized financial side effects.

## S06 — Ban, logout and session lifetime are inconsistent across HTTP and sockets

**Location:** `backend/src/modules/auth/service.js:179-202`; `backend/src/sockets/middleware.js:16-43`; `app/lib/providers/auth_provider.dart:155-175`; `app/lib/services/socket_service.dart`. **CWE-613 / CWE-863.**

HTTP authorization checks the current user's ban flag. Refresh does not check the user at all, and socket authentication verifies only the JWT signature/expiry. A banned user with a refresh token can obtain a fresh access token and establish a socket. Existing sockets have no token-expiry or revocation recheck. Flutter logout clears local storage but does not disconnect/reset the singleton SocketService; a later account on the same running app can retain the previous account's connected socket.

The controlled test demonstrates refresh plus socket authentication without a user lookup even when the fixture user is banned. This does not bypass the separate HTTP ban check.

**Fix:** Bind refresh tokens to a session/family and validate account/session status during refresh and socket authentication. Revoke/disconnect sessions on ban/logout, enforce connection lifetime, and clear user-specific providers/socket state on account change. Decide explicitly whether access tokens remain valid after ordinary logout; implement that policy consistently.

**Acceptance:** Banned users cannot refresh or continue socket actions; logout/account switching cannot receive the prior account's events or send its actions.

## S07 — Refresh rotation allows concurrent reuse

**Location:** `backend/src/modules/auth/service.js:179-194`. **CWE-362 / CWE-613.**

Refresh uses separate Redis GET and DEL operations and ignores whether DEL consumed the token. Two simultaneous requests can read the same valid token and each issue a successor. A controlled test produced two distinct refresh tokens from the same old token.

**Impact:** Weakens stolen-token replay detection and session revocation. Exploitation requires possession of a valid refresh token; this is not anonymous token forgery.

**Fix:** Consume/rotate atomically with Lua or an equivalent transaction and maintain family revocation/reuse semantics. Handle response loss intentionally rather than granting unlimited parallel successors.

## S08 — Deposit credit is not bound to a verified payment intent

**Location:** `backend/src/modules/payment/webhookController.js:17-106`; wallet service `processDepositWebhook`; gateway initialization methods. **CWE-20 / CWE-841.**

The application does not persist an expected deposit reference, wallet, currency and amount when initialization succeeds. Webhooks credit the metadata user and reported amount without matching a stored intent or checking wallet currency. Flutterwave conversion uses floating-point Number/rounding. The controller does not perform a provider transaction lookup before crediting.

The local HTTP fixture supplied a correctly signed Paystack event with GBP currency to an NGN wallet and observed a credit. The signature used a local test key. This demonstrates missing business validation, not an ability to forge a real provider signature. Real-world exploitation depends on the provider/account/payment pathways producing a mismatched valid event; secret possession was not assumed as an attacker capability.

**Positive control:** Paystack raw-body HMAC checking is present and refuses an empty configured key. The unique gatewayReference and transaction prevent the same reference being credited twice in ordinary duplicate delivery. These controls do not establish intent/currency correctness. Duplicate webhook delivery still sends repeated notifications/events after the idempotent service returns success.

**Fix:** Store server-created intents before exposing checkout; verify successful transactions against expected reference, provider, amount, currency and wallet. Parse money without floating-point ambiguity. Make duplicate processing return a distinct already-applied result and emit from a durable event record. Select Flutterwave signature handling for the provider API version actually used; the repository currently uses its legacy `verif-hash` convention.

**Acceptance:** Validly signed wrong-currency, wrong-user, wrong-amount, unknown-reference and duplicate events cannot create an incorrect or repeated credit.

## S09 — Country and identity controls are client assertions

**Location:** `backend/src/modules/auth/controller.js:18-39,63-76`; auth service `register`; `backend/src/services/geoService.js`; wallet withdrawal route; `backend/src/middleware/auth.js`.

The country field is optional and accepted directly from the request. Omitting it bypasses the country test; supplying an allowed code does too. `/auth/geo-locate` is not cryptographically or server-session bound to registration, and the GPS coordinates it receives are themselves client input. The reproduction confirms a registration with no country evidence and `ageVerified: true` based only on a claimed date of birth. The actual date is not persisted.

`kycStatus` exists in the database but is not checked by the withdrawal path. Safer-play restrictions have no corresponding enforcement in the audited money/match paths. These are technical enforcement gaps relative to the intended product controls, not a conclusion about the laws of any country.

**Fix:** Define a server-owned eligibility record with evidence/status/provenance; distinguish self-declared age from verified identity. Enforce required country, KYC and safer-play status at money and match entry, including worker execution after queuing. Do not trust a frontend checkbox or country string as verification.

## S10 — Debits commit before recoverable game initialization

**Location:** `backend/src/modules/callout/service.js:128-149`; `backend/src/jobs/matchmakingWorker.js`; `backend/src/sockets/gameManager.js:81-116`; reconciliation sweep.

Stake debits and ACTIVE match creation commit before Redis initialization. Initialization consists of several separate writes. A Redis outage or process crash can leave debited users, an ACTIVE database match and no usable game or only partially written active-match pointers. The matchmaking error message encourages retry despite a potentially committed debit. Reconciliation only alerts on old database matches with missing Redis state; it does not reconstruct or release them.

**Fix:** Model preparation/activation explicitly. Commit a durable game-start/outbox operation with the reservations, then initialize Redis idempotently and acknowledge activation. A recovery worker must reconstruct or release the same operation exactly once. Do not automatically replay a debit after an ambiguous activation failure.

**Acceptance:** Crash injection after every database/Redis boundary produces a playable match or a recorded release; no orphaned reservation and no second debit.

## S11 — Accepted move history can be lost; database recovery is still broken

**Location:** `backend/src/sockets/gameManager.js:39-60,270-324`; `backend/src/modules/match/controller.js:91-117`; MatchMove schema.

The server broadcasts the Redis-accepted move and launches database persistence without awaiting it. Exhausted persistence retries are logged and swallowed, so gameplay/settlement can advance without durable evidence. `(matchId, moveNumber)` is not unique, so an ambiguous successful database write followed by retry may duplicate the audit record.

The HTTP fallback still assigns `board = applyMove(board, moveObj)` instead of the returned `.newBoard`. The live move path was repaired in the new revision, but fallback recovery was not. One logged move returns a board object instead of the expected array; later applications can fail. Move broadcast and recovery responses also omit the authoritative version needed to robustly discard stale events.

**Fix:** Establish a durable, uniquely keyed accepted-move log before treating the move as durably accepted, or implement a persistent recoverable event stream with a tested loss policy. Repair fallback extraction, validate contiguous move numbers and include match/version identity in all game responses. Redis snapshots and financial settlement must be reconcilable to the accepted audit trail.

**Acceptance:** Database failures, Redis loss, duplicated delivery and process restarts preserve one replayable move history and cannot settle from missing/conflicting evidence.

## S12 — Development Compose configuration is unsafe if exposed

**Location:** `backend/docker-compose.yml`; `backend/.env.example`.

The Compose file publishes PostgreSQL 5432 and Redis 6379 on all host interfaces. PostgreSQL uses the sample `user/password`; Redis has no configured password/ACL or TLS in this file. The environment example also contains a known sample JWT secret, while startup checks only that a secret exists.

**Conditional impact:** If this configuration is deployed to a reachable host without network controls, database/game-state compromise can undermine the entire wallet and settlement model. Host firewall rules, effective Redis protection and actual production credentials were not inspected. This is not proof that the VPS is publicly exposed or that a live secret was leaked.

**Fix:** Keep data services on a private network or loopback-only bindings, use unique protected credentials and least-privilege users/ACLs, reject known sample secrets in production, and verify host-level exposure. Avoid publishing data ports at all when only application containers need them.

## S13 — Bearer credentials and sensitive data enter logs

**Location:** `backend/src/app.js:48-55`; `backend/src/utils/logger.js`; auth controller geo-location logging; notification service mock FCM logging. **CWE-532.**

The pino-http setup uses request serializers without credential redaction. A local experiment with the same logger configuration confirmed `authorizationRecorded: true` for a synthetic bearer token. Tokens in production logs are usable credentials for their remaining validity and expose users to anyone with log access. The code also logs precise supplied coordinates and FCM registration tokens. No actual user token was printed or used by this audit.

**Fix:** Redact authorization/cookie/token/password/key fields at the root logger, including nested error/provider objects, and minimize location/contact logging. Review retention and access for logs that may already contain credentials. Add a fixture that fails if a synthetic secret survives serialization.

## S14 — Rate limiting is weaker than the comments claim

**Location:** `backend/src/middleware/rateLimit.js:8-55`; `backend/src/sockets/index.js`; call-out notification fanout; wallet/notification pagination.

`createStore()` tests the new Redis client's readiness synchronously while the module is importing. It selects the in-memory store before the asynchronous connection becomes ready, and never switches. Limits are therefore normally per process, reset on restart and multiply across instances. No socket event/user/connection budget is present. HTTP limits do not cap socket move/join traffic. Several list endpoints accept unbounded page sizes, and one call-out can fan out notifications to every user in a tier.

**Fix:** Initialize the shared limiter deliberately after connection readiness, with separate key prefixes and explicit outage behavior. Add per-user and per-event limits, connection/room quotas, bounded pagination and queued/bounded notification fanout. Configure trusted proxies only for the actual deployment; do not blindly trust all forwarded IP headers.

## S15 — Active-match and presence invariants are not enforced

**Location:** matchmaking join route; call-out accept service; `gameManager.js:104-107`; `settlement.js:26-28,69-71`; disconnect handler/sweep.

A user can queue in multiple stake buckets or accept additional call-outs while already active. Database match creation does not enforce one active match per user. Redis stores just one `user:<id>:activeMatch` pointer, so newer matches overwrite older ones. Cleanup unconditionally deletes that pointer, even if it now belongs to a different match.

Disconnect processing creates a grace deadline when any socket disconnects. Presence checks use the local Socket.IO adapter; the server has no shared adapter configured. In multi-instance deployment, another instance's connected socket is invisible, enabling false forfeits. The read/check/settle sequence is not atomic, and removing work before a durable terminal claim can lose retries.

**Fix:** Atomically reserve each participant for one active match, compare-and-delete pointers by match ID, represent presence across all sockets/instances, and claim a specific expired presence generation before finalization. Persist recoverable terminal work. This must compose with S02 rather than becoming a second settlement path.

## S16 — Fee terms and wallet transaction arithmetic are inconsistent

**Location:** `backend/src/sockets/settlement.js:175-195`; PlatformSettings/Match models.

Settlement reads the current global commission instead of a fee snapshot accepted when the match was funded. Changing settings during a game changes its eventual payout. It credits the net payout to the winner, then records a PAYOUT of that net amount plus a negative COMMISSION on the same wallet. For a 200-unit pot and 20-unit fee, the wallet increases by 180 while those two new transaction rows sum to 160. This makes transaction-sum reconciliation disagree with the balance.

**Fix:** Persist accepted stake/currency/fee terms on the match and enforce fee bounds. Choose one consistent ledger convention: gross payout plus fee debit, or net payout with commission booked separately to platform accounts. Every balance change must reconcile to its signed entries.

## S17 — Match history unnecessarily exposes email addresses

**Location:** `backend/src/modules/match/controller.js:29-43`. **CWE-200.**

The repaired history endpoint fetches and returns both participants' email addresses to each participant. An opponent needs a public name/avatar, not a private login/contact identifier. The code explicitly includes email in the response.

**Fix:** Return public profile fields and restrict contact fields to the account owner. Verify the history and call-out payloads against an explicit public profile DTO. `/auth/check-availability` also intentionally reveals email/phone existence; assess whether that oracle is needed and apply targeted abuse controls.

## S18 — Online players have no enforced turn deadline

**Location:** `backend/src/sockets/gameManager.js` initial state and move preconditions; backend scheduled jobs.

The server records last-move timestamps but does not enforce an active turn clock or turn-expiry settlement. Disconnect timeout only applies after a disconnection. A player can stay connected and stop moving indefinitely, tying up both stakes. The Redis game TTL eventually removes state without resolving the ACTIVE database match.

**Fix:** Store authoritative time controls/deadlines, check expiration atomically with every move, and run recoverable deadline processing through the common terminal gate. Clock policy must be explicit for reconnect and ready phases.

## Dependencies, secrets and deployment observations

### Dependency scan

`pnpm audit --prod --json` against the committed pnpm lockfile reported **15 advisory entries: 9 high and 6 moderate, 0 critical**. These are advisory entries, not 15 independently demonstrated application exploits. The paths include:

- `express-rate-limit > ip-address`: three advisories, including leading-zero IPv4 interpretation. No attacker-controlled SSRF filter using that API was identified in this app. [Primary advisory](https://github.com/advisories/GHSA-mwp4-54f8-5fhr).
- `express > body-parser > qs`: two moderate advisories. This app uses JSON/raw body parsing and Express's default query behavior; the affected parser options were not established as reachable. [Primary advisory](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx).
- Optional `@prisma/client > prisma` tooling paths include find-my-way, valibot, fast-uri, deepmerge-ts and mysql2. The app uses PostgreSQL, and no MySQL application connection path was identified. The deepmerge advisory requires cyclic object graphs rather than plain JSON. [Deepmerge advisory](https://github.com/advisories/GHSA-ggr8-5vv4-36mx), [MySQL advisory](https://github.com/advisories/GHSA-3f6p-5ww8-9rcr).

`npm audit --omit=dev` reported four high package entries from the other committed lockfile. CI installs with pnpm, so that npm count is not the canonical deployed dependency assessment. Keep one authoritative lockfile and inspect the built production image's actual dependency graph. Do not run a forced major downgrade suggested by npm without compatibility review. The raw advisory reports are included so patched ranges and every path remain reviewable.

### Secret scanning

A pattern-based scan of **450 text blobs across all locally fetched refs** found no matches for the selected GitHub token, AWS access-key, live payment-key, literal JWT or private-key-header patterns. This is a limited negative result, not certification that the repository/history contains no secrets. Known example passwords/secrets remain in configuration, and runtime log leakage is independently confirmed. No entropy scan, external secret validation or live credential testing was performed.

### Other release gaps

- Android release builds use the debug signing configuration in `app/android/app/build.gradle.kts`. Configure controlled release signing before distribution; no shipped APK was examined.
- Checkout WebView permits unrestricted JavaScript and uses substring checks for `callback`/`success`. Validate provider HTTPS origins and exact return URLs. Closing this view alone does not credit a wallet, so this is not presented as a payment-credit bypass.
- WithdrawalRequest has no destination/account, provider payout reference, request idempotency key or explicit executing/unknown/reversed lifecycle. The audited request path creates a liability but does not implement a complete auditable bank payout workflow.
- The frontend receives mismatched game-state shapes (for example board JSON text from socket join versus model expectations), lacks handling for the generic final `match_ended` event, and does not fully rejoin/resynchronize on socket reconnect. These reliability gaps compound S06/S11/S15.
- Feature flags are declared/tested but are not consulted by the money or match handlers. Setting WITHDRAWAL_V2/SETTLEMENT_V2 does not enable a secure replacement. There is no verified money kill switch in the reviewed code.
- Backend CI runs unit tests; frontend CI checks color-token usage only. Neither workflow establishes financial integration correctness, dependency reachability, mobile security or deployment hardening. Action versions are tags rather than immutable SHAs. GitHub branch protection/secret-scanning settings were not inspected.

## Controls that are present

The audit did not treat every protection as absent. The code uses bcrypt cost 12, short-lived signed JWTs, a current-user ban check on protected HTTP routes, parameterized Prisma/raw SQL calls in the reviewed paths, raw-body Paystack signature checking, unique gateway references, conditional withdrawal rejection, ordered wallet locks for distinct-player stake debit, Redis version CAS for move updates, HTTP match-membership checks, user-scoped notification updates, Helmet and restricted production CORS configuration. No concrete SQL-injection, shell-execution or arbitrary-file-upload path was found in the reviewed code. CORS is not an authorization boundary for native/nonbrowser clients.

## Repair order and evidence required to close the audit

1. **Contain current exposure:** fix malformed socket handling and token logging; verify network isolation and nonexample secrets. If this revision serves real funds, suspend affected money/match operations until invariant fixes are verified. Existing V2 flags are not such a suspension mechanism.
2. **Protect money:** fix guarded/idempotent withdrawals and one terminal/settlement gate, including participant validation and ledger uniqueness. Add real PostgreSQL race tests before enabling payouts.
3. **Protect access:** enforce match membership, self/cross-tier rejection, account/session revocation and authoritative eligibility on all entry paths.
4. **Make failure recoverable:** implement durable activation, move/settlement event records, recovery and multi-instance presence. Add process-crash and Redis/database outage tests.
5. **Complete payment contracts:** persist and verify intents, reconcile fee entries, implement bank payout state transitions and exact retry semantics.
6. **Release hardening:** repair mobile logout/reconnect, configure signing, close privacy leaks, verify actual runtime dependencies and expand CI with the adversarial cases above.

A passing mock suite is insufficient closure for S01/S02/S10/S11/S15. Closure requires tests against real PostgreSQL/Redis, concurrent clients, lost responses, restarts and at least two application instances where multi-instance operation is intended. Verify all fixes at a new immutable commit and record deployed-version evidence separately.

## Reproduction package

The included `security.audit.test.js` imports the application's real modules and mocks external state/services. Copy it into `backend/` of an isolated checkout at the audited commit, install the locked dependencies with the project's approved setup, then run:

```bash
NODE_ENV=test REDIS_URL= DATABASE_URL= node --experimental-vm-modules node_modules/jest/bin/jest.js security.audit.test.js --runInBand
```

The separate `security.socket-crash.mjs` starts and attacks only its own loopback server with a synthetic token. Run it only in a disposable local checkout:

```bash
node security.socket-crash.mjs
```

Expected vulnerable result: exit code 1, authenticated connection marker, then the null-destructuring stack trace. The script does not use real users or payment keys. Evidence files include baseline coverage/test output, controlled reproduction output, crash output, both dependency audit reports and the limited secret-scan result.

The earlier audit was at `e6d6f7f`. This review independently verified the new revision: the first-move live-game return-value defect is repaired and tests expanded, while the HTTP recovery defect and major money/authorization issues above remain. No repair commits or remote changes were made during this audit.
