# Backend vs Docs — Full Contract Audit

**Date:** 2026-09-22
**Scope:** What the backend actually implements vs what `New Folder/Draught_Bet_Backend_Master_Package_v1/` requires, audited per the build order in `04_Repo_Remediation`.
**Baseline audited:** local `refactor/backend-v2` HEAD `0883d38` (deployed/authoritative).

Legend: ✅ implemented · ⚠️ implemented but drifted from contract · ⚠️~ partial · ❌ missing / not started · (legacy) kept for backward compat

---

## 1. REST surface

### 1.1 Auth / profile / sessions

| Contract (API contract §3-4, openapi) | Implemented | Status |
|---|---|---|
| `POST /auth/register` | `/auth/register` | ✅ |
| `POST /auth/login` | `/auth/login` | ✅ |
| `POST /auth/refresh` (rotate) | `/auth/refresh` (reuse detection per `session_refresh_unique` migration) | ✅ |
| `POST /auth/logout` | `/auth/logout` | ✅ |
| `POST /auth/verify/start` + `/auth/verify/confirm` | `/verification/start` + `/verification/status` | ⚠️ path drift; OTP start only, no verify/confirm pair |
| `POST /auth/forgot-password` | — | ❌ |
| `POST /auth/reset-password` | — | ❌ |
| `GET/PATCH /me` | `GET/PATCH /auth/me` | ⚠️ path drift |
| `GET /me/sessions`, `DELETE /me/sessions/{sessionId}` | — (UserSession rows + security events exist, no endpoints) | ❌ |
| `GET /me/eligibility` | — (EligibilityService is internal-only, see §2.4) | ❌ public explain endpoint |

### 1.2 Verification / KYC / safer-play

| Contract | Implemented | Status |
|---|---|---|
| `GET /me/verification` | `/verification/status` | ⚠️ path |
| `POST /me/verification/session` (KYC provider session) | — (`verification/providerAdapter.js` exists but no provider session endpoint/callback) | ❌ |
| `GET/PATCH /me/limits` | `/safer-play/profile` + `PUT /deposit-limit` + `PUT /stake-limit` | ⚠️ path + split |
| `POST /me/time-out` | `/safer-play/timeout` | ⚠️ path |
| `POST /me/self-exclusion` | `/safer-play/self-exclusion` | ⚠️ path |

### 1.3 Wallet / deposits / withdrawals

| Contract | Implemented | Status |
|---|---|---|
| `GET /wallet` (available/locked/pending) | `/wallet/balance` (ledger projections — PR3 verified) | ⚠️ path |
| `GET /wallet/transactions` | `/wallet/transactions` (ledger-facing, paginated) | ✅ |
| `POST /deposits` (Idempotency-Key required) | `/wallet/deposit-intent` | ⚠️ path; **no client idempotency key on create** |
| `GET /deposits/{depositId}` | — | ❌ gap |
| `POST /webhooks/paystack`, `/flutterwave` | `/webhooks/paystack`, `/webhooks/flutterwave` | ✅ signature/amount/currency/reference verified vs server-owned intent; duplicate delivery acked without re-credit |
| `GET/POST /me/bank-accounts` | `/wallet/bank-accounts` (+ default/delete) | ⚠️ path |
| `POST /withdrawals` (Idempotency required) | `/wallet/withdrawal-request` (`idempotencyKey` in body, unique per user) | ⚠️ path |
| `GET /withdrawals/{withdrawalId}` | `/wallet/withdrawals` (list only) | ⚠️~ no single-status route |

### 1.4 Lobby / matches / matchmaking

| Contract | Implemented | Status |
|---|---|---|
| `GET /matches` (lobby) | `GET /callouts/open` | ⚠️ same concept, different resource/name |
| `POST /matches` (create; DRAFT→OPEN) | `POST /callouts` (straight to OPEN, no DRAFT) | ⚠️ path + no DRAFT publish step |
| `GET /matches/{matchId}` (metadata + participants) | `GET /matches/:id/state` (canonical game state) | ⚠️ shape drift |
| `POST /matches/{matchId}/join` | `POST /callouts/:id/accept` | ⚠️ path; reserves both stakes → FUNDED |
| `POST /matches/{matchId}/ready` | — (readiness replaced by `gameActivationService` auto-activation claim after both join) | ❌ REST ready |
| `POST /matches/{matchId}/cancel` | — (cancellation only via callout expiry job / activation-abandon release) | ❌ no user-facing cancel |
| `POST /matchmaking/search` + `DELETE /search/{searchId}` | `POST /matchmaking/join` + `POST /matchmaking/leave` (Redis ZSET, atomic Lua pair-pop) | ⚠️ path; no durable searchId resource |

### 1.5 History / receipt / replay / disputes

| Contract | Implemented | Status |
|---|---|---|
| `GET /me/matches` | `GET /matches/history` | ⚠️ path |
| `GET /matches/{matchId}/receipt` | — (MatchReceipt rows ARE written at settlement; no fetch endpoint) | ❌ **gap** (contract path exists in openapi line 751) |
| `GET /matches/{matchId}/replay` | — (MatchMove + boardStateAfter + GameEvent exist; no endpoint) | ❌ **gap** |
| `POST /matches/{matchId}/disputes` | — (DisputeCase/DisputeEvidence models exist; no module/route) | ❌ **gap** |

### 1.6 Admin (contract §9)

All of these are ❌ **missing** — the admin module only exposes MFA bootstrap (`/admin/mfa/status|setup|verify|disable`):

`/admin/users`, `/admin/users/{userId}` (SUPPORT+), `/admin/withdrawals` + `/approve` + `/reject` (FINANCE), `/admin/kyc/cases` + `/decision` (RISK), `/admin/matches/{id}/evidence` (GAME_OPS), `/admin/ledger/adjustments` (FINANCE/SUPER), `/admin/audit` (AUDITOR).

- RBAC/permissions, `AdminRole`/`AdminRoleAssignment`, `AdminMfa`, `AdminAuditLog` exist and withdrawals carry `APPROVED` status + `reviewedBy`, but **no admin controller serves them**. Consequence: withdrawal review cannot be driven via UI, ledger adjustments and disputes have no admin path.
- Correctly absent per contract §9 ("no setBalance / no setWinner"): ☑️ honoured by design, but no audited adjustment alternative exists as an endpoint either.

---

## 2. Socket.IO surface

| Contract (socket-contract-v1.md lines 16-30) | Implemented | Status |
|---|---|---|
| C→S `match.join` | `match.join` (+ legacy `join_match`) | ✅ |
| S→C `match.state` | `match.state` (canonical resync) | ⚠️ shape drift — see below |
| C→S `player.ready` | — | ❌ (no event; auto-activation instead) |
| S→C `game.started` | — (activation flips status to IN_PLAY; no start event) | ❌ |
| C→S `move.submit {clientMoveId, expectedStateVersion, from, path}` | `move.submit` (V2) + legacy `move_attempt` | ✅ |
| S→C `move.accepted` | `move.accepted` (+ legacy `move_applied`) | ✅ |
| S→C `move.rejected` | `move.rejected` (+ legacy `move_rejected`) | ✅ stable codes (`MOVE_ERROR`) |
| S→C `clock.sync` | `clock.sync` | ✅ |
| S→C `opponent.connection` | `opponent_disconnected` / `opponent_reconnected` | ⚠️ name drift |
| C→S `draw.offer` | — | ❌ **no draw handler at all** (engine draws by rule exist only) |
| C→S `draw.respond` | — | ❌ |
| C→S `match.resign` | `match.resign` (+ legacy `resign`) | ✅ |
| S→C `match.finished` | `match_ended` / `match_ended_resign` `{winnerId, reason, payout}` | ⚠️ name + payload drift (no settlementStatus/flags) |
| S→C `wallet.updated` | **outbox eventType `wallet.updated` (dot) but socket emit is `wallet_updated` (underscore)** — `outboxDrainer.js:32` | ⚠️ wire event name wrong vs contract |
| S→C `settlement.completed` | — | ❌ not emitted |

### 2.1 `match.state` payload drift (`gameProtocol.js:34-67`)
Implemented returns `version, board, currentTurn, currentTurnUserId, status, winnerId, moveCount, deadlineAt, timeControlSeconds, turnStartedAtServer, serverNowMs, remainingMs, disconnectGraceMs, legalMoves`.
Contract requires `matchId,status,stateVersion,board,sideToMove,clocks,participants,connection,pendingDrawOffer`.
→ field naming drift (`version` vs `stateVersion`, `currentTurn` vs `sideToMove`) + **missing `participants`, `connection`, `pendingDrawOffer`** (clocks are present as flat fields, extra `legalMoves` — harmless).

### 2.2 Reconnect
Contract: reconnect → `match.join` → `match.state`. ✅ implemented (legacy `game_state` also emitted from `disconnectHandler.js:128` for old clients).

---

## 3. Database (package `draught-bet-schema.prisma` vs implemented `backend/prisma/schema.prisma`)

Implemented models: `User, Eligibility, Wallet, DepositIntent, WithdrawalRequest, Match, MatchMove, Callout, DeviceFingerprint, AdminAuditLog, PlatformSettings, Notification, GameOutbox, UserSession, VerificationChallenge, ConsentRecord, SecurityEvent, VerificationCase, VerificationCheck, SaferPlayProfile, SaferPlayEvent, LedgerAccount, LedgerTransaction, LedgerEntry, Withdrawal, BankAccount, FinancialReconciliationRun, MatchParticipant, StakeReservation, MatchSettlement, MatchReceipt, MatchGameState, GameEvent, GameStateSnapshot, MatchConnectionEvent, AdminRole, AdminRoleAssignment, RiskEvent, RiskCase, DisputeCase, DisputeEvidence, OutboxEvent, IdempotencyRecord, AdminMfa`.

| Package model | Implemented | Status |
|---|---|---|
| `KycDocument` (private doc storage) | — | ❌ |
| `SaferPlayDailyUsage` | — | ❌ (daily deposit limit computed on the fly, no usage table) |
| `RulesetVersion` | `rulesetVersion` Int column on Match only | ⚠️~ no versioned ruleset table |
| `PlatformConfigVersion` | `PlatformSettings` single row | ⚠️ no config history/versioning |
| `PaymentWebhookEvent` | — (webhook dedupe relies on intent status + ledger keys, no webhook log) | ⚠️~ no forensic log |
| `WithdrawalReview` | folded into `Withdrawal.status`+`reviewedBy` | ⚠️~ |
| `MatchmakingRequest` | Redis-only | ⚠️~ no durable search record |
| `DirectChallenge` | `Callout` generalizes (open challenge list) | ⚠️~ direct-challenge match type not modeled |
| `SupportCase`/`SupportCaseEvent` | — | ❌ |
| `PlayerStats`/`RatingEvent` | — | ❌ |
| `DevicePushToken` | — | ❌ |
| `ReconciliationIssue` | `FinancialReconciliationRun.discrepancies` JSON | ⚠️~ |
| `WalletBalanceProjection` | `Wallet` holder + LedgerAccount projections (no cached read-model) | ⚠️~ |
| `Device` + `Session` | combined `UserSession` + `DeviceFingerprint` | ⚠️~ |

**Ledger event-type drift (decisions §10):** contract names `DEPOSIT_CONFIRMED/FAILED/REVERSED, STAKE_RESERVED/RELEASED, MATCH_SETTLED_WIN/LOSS/DRAW, WITHDRAWAL_PENDING/CONFIRMED/FAILED/REVERSED, ADJUSTMENT_CREDIT/DEBIT`; implemented enum is `DEPOSIT_CREDIT, STAKE_LOCK, STAKE_RELEASE, SETTLEMENT_PAYOUT, WITHDRAWAL_RESERVE, WITHDRAWAL_COMPLETE, WITHDRAWAL_RELEASE, ADJUSTMENT`. No draw-specific settlement type, no deposit failed/reversed types.

---

## 4. PR build-order status (`04_Repo_Remediation` §30)

| PR | Verdict | Notes |
|---|---|---|
| PR0 baseline/safety net | ⚠️~ | requestId middleware ✅; smoke/integration test suite ✅; feature-flag infra (§31 `LEDGER_V2_*` flags) ❌; Stripe dep still present in `Gateway` enum |
| PR1 V2 schema (additive) | ✅ | All V2 tables added via migrations without removing V1; `readflip_v3` later drop of wallet mirror is progression |
| PR2 LedgerService | ✅ | Balanced postings, account creation, projections, unique `idempotencyKey` (ledger.integration.test) |
| PR3 wallet READS → ledger | ✅ | `/wallet/balance` + `/wallet/transactions` ledger-backed (PR3 live-verified) |
| PR4 match lifecycle + stake reservation | ⚠️ broad ✅ | `MatchService`/`StakeService`, OPEN/FUNDED/READY/IN_PLAY, config snapshot (fee %, time control, config version), both-stakes→FUNDED, release on expiry/abandon. Deltas: no DRAFT publish, no REST cancel, ready = auto-activation, not explicit `player.ready` |
| PR5 settlement V2 | ⚠️ | Atomic + idempotent (unique match), winner payout, draw release, `MatchReceipt` rows, outbox events. Deltas: fee frozen as percent not bps-consistent naming, receipt has no `reference` column, no receipt endpoint, no `match.finished`/`settlement.completed` events |
| PR6 deposit V2 | ✅ strong | Server-owned intents, gateway mapping, signature/amount/currency/reference verification, ledger credit, reconciliation job, outbox `wallet.updated`. Deltas: no `GET /deposits/{id}`, no client idempotency key on create |
| PR7 withdrawal V2 | ⚠️ | BankAccount + V2 `Withdrawal`, available→withdrawal-pending, KYC/eligibility gate, provider payout + follow-up, failed→release, idempotency key. Deltas: admin approve/reject surface missing, no `GET /withdrawals/{id}` |
| PR8 game protocol V2 | ✅ strong | `clientMoveId`, `expectedStateVersion`, full capture path, durable move log + outbox, stable `MOVE_ERROR` codes, canonical `match.state` resync, legacy events kept |
| PR9 server clock + reconnect | ✅ strong | `timeControl`, `deadlineAt`, `clock.sync`, turn-deadline forfeit sweep, disconnect grace + `MatchConnectionEvent` evidence, restart recovery |
| PR10 KYC/eligibility/safer-play | ⚠️~ | Central `EligibilityService` ✅ used on deposit/withdraw/match/callout/verification; saferPlay module (limits/timeout/self-exclusion cross-device) ✅; contact OTP verification ✅. Deltas: no KYC provider session/callback flow (`providerAdapter.js` scaffold only), no public eligibility endpoint |
| PR11 admin/RBAC/audit/disputes | ❌ | RBAC/roles/MFA/audit-log storage exist, **but no admin endpoints, no disputes API** — the largest unimplemented block (§1.6) |
| PR12 workers/outbox/reconciliation | ✅ strong | outboxDrainer, providerFollowUp, depositReconciliation, financialReconciliation, disconnect/reconciliation/calloutExpiry/gameActivation/turnDeadline sweeps, matchmakingWorker, gameRecovery — retry-safe, restart-safe |
| PR13 security hardening | ⚠️~ | Done: admin MFA, refresh reuse detection, per-surface rate limits, TLS enforcement, CORS allowlist, app-version gate + dormancy cleanup. Open: KYC private storage, load/security test sweep, DB/Redis least-privilege verification |

---

## 5. Gap register (backend must act)

Severity A — blocks contract completeness / frontend PRs:

1. **Draw protocol missing server-side.** No `draw.offer` / `draw.respond` handlers, no pending draw state in `match.state`. Contract socket events (socket-contract lines 25-26) + blueprint §17.2 + admin/dispute evidence expect it. Blocks the app's draw UI end-to-end.
2. **Result/wallet wire events.** Emit `match.ended`-family instead of contract `match.finished`, and `wallet_updated` (underscore) instead of `wallet.updated` (dot — which the backend's own outbox already names correctly). Frontend listens to the dot names (contract-correct) — currently dead on the wire.
3. **Missing REST endpoints required by audit-facing flows:** `GET /deposits/{depositId}`, `GET /withdrawals/{withdrawalId}`, `GET /matches/{matchId}/receipt` (openapi line 751), `GET /matches/{matchId}/replay`, `POST /matches/{matchId}/disputes`, `POST /matches/{matchId}/ready`, `POST /matches/{matchId}/cancel`, `GET /me/eligibility`.
4. **Admin surface entirely absent** (users/withdrawals/kyc/evidence/ledger-adjustment/audit endpoints) → withdrawal approval workflow cannot run through a UI.

Severity B — contract fidelity:

5. REST path namespace drift vs contract (`/wallet/*`, `/callouts`, `/matchmaking/join|leave`, `/verification/*`, `/safer-play/*`, `/auth/me` vs documented `/me`, `/matches/*`, `/deposits`, `/matchmaking/search`). Also `/api/v1` prefix absent at app layer.
6. `match.state` field naming + missing `participants`/`connection`/`pendingDrawOffer`.
7. No client idempotency key on deposit create (deposits need retry safety; intents dedupe by server reference instead).
8. Ledger entry-type names diverge from decisions §10 (no draw/deposit-failed/reversed semantics).
9. `game.started`, `player.ready`, `settlement.completed`, `opponent.connection` wire names missing/drifted.
10. KYC provider session flow + forgot/reset password absent.
11. Schema gaps: `KycDocument`, `SaferPlayDailyUsage`, `PaymentWebhookEvent`, versioned platform config, `PlayerStats`, push tokens, support cases.

Not gaps (deviations recorded as design choices already in the remediation plan):
- Callout system kept as the lobby (`§19` call-out/challenge).
- Feature flags removed (plan §31 says remove when stable).
- Engine (10×10 International, mandatory/max capture) untouched as required (§33).

---

## 6. Cross-impact for frontend PRs (summary)

- PR4 match lifecycle: backend is compatible on the events the app already uses (`match.state`/`move.*`/`join`/`resign`); the app must consume `version`/`currentTurn` naming until §B6 is resolved.
- PR5 settlement UI: blocked items are **real backend gaps** — `match.finished`, `settlement.completed`, `GET /matches/{matchId}/receipt`. `GET /settlements/{matchId}` (app-created) is frontend drift and should be replaced by the receipt endpoint once built.
- PR6 deposit UI: contract-correct app calls (`GET /deposits/{reference}`, `access`-token state) need `GET /deposits/{depositId}`; `POST /deposits/quote` remains frontend invention.
- PR7 withdrawal UI: `GET /withdrawals/{withdrawalId}` needed; `/wallet/withdrawals` list exists.
- PR8 game protocol: implemented as contracted (move idempotency/resync/legalMoves) — strongest area.

---

## Authoritative doc references
- `04_Repo_Remediation/Draught_Bet_Backend_V2_Repo_Remediation_Plan.md` §30 (PR 0-13), §31 (flags), §34 (rewrite order)
- `02_API_and_Realtime/Draught_Bet_API_and_Realtime_Contract_v1.docx` §3-9 (REST), §11 (socket), §10 (error codes)
- `02_API_and_Realtime/draught-bet-socket-contract-v1.md` lines 16-30 (events), 50 (reconnect)
- `02_API_and_Realtime/draught-bet-openapi-v1.yaml` lines 470-539 (deposit/withdrawal), 751 (receipt)
- `01_Planning_and_Architecture/Draught_Bet_Backend_Engineering_Blueprint_v1.docx` §4 (tables), §15-16 (move/clock), §19 (settlement), §27-28 (contracts)
- `01_Planning_and_Architecture/decisions.md` §10 (ledger events), §11 (stake), §12 (states), §39 (idempotency), §54 (rate limits)
- `03_Database_and_Ledger/draught-bet-schema.prisma` (proposed baseline)