# 03 — Backend Specification

Stack: Node.js + Express + Prisma + Redis (ioredis) + Socket.IO + Paystack + Flutterwave + node-cron (Stripe is not part of this Phase 1 build — see §Core packages below and `01_PRODUCT_CONTEXT.md`; it's added in the Phase 2 global/GBP expansion). See `02_DATABASE_SCHEMA.md` for all data models referenced below.

## Folder structure

```
src/
  modules/
    auth/          controller.js, service.js
    wallet/
    match/
    engine/        pure game logic — zero imports from anywhere else in the app
    callout/
    admin/
    notification/
  middleware/       auth.js, rateLimit.js, tierEnforcement.js, errorHandler.js
  sockets/          index.js, handlers/
  jobs/             node-cron scheduled tasks
  prisma/           schema.prisma, migrations/
  utils/
```

## Core packages

`express socket.io @prisma/client ioredis jsonwebtoken bcrypt axios zod helmet express-rate-limit rate-limit-redis cors pino pino-http dotenv uuid node-cron firebase-admin`

No dedicated Paystack/Flutterwave SDK is needed — both expose plain REST APIs, called via `axios` inside a payment-gateway abstraction (see §Wallet & payments below). The `stripe` package is intentionally not installed for the Phase 1 (Nigeria) build — it gets added when the GBP/global phase starts, per `01_PRODUCT_CONTEXT.md`.

---

## Auth module

- `POST /auth/register` — `zod`-validated (email, password, dateOfBirth). Enforces 18+ via `dateOfBirth`. bcrypt 12 rounds. Creates `User` + empty `Wallet` in one Prisma transaction. Captures device fingerprint hash from request body into `DeviceFingerprint`.
- `POST /auth/login` — validates credentials, checks `isBanned`, issues 15-min JWT access token + 7-day refresh token (Redis, keyed `refresh:{userId}:{tokenId}`).
- `POST /auth/refresh` — validates refresh token against Redis, rotates it, issues new access token.
- `POST /auth/logout` — deletes refresh token from Redis.
- `GET /auth/me` — current user profile + wallet balance + unread notification count, from JWT payload + DB lookup.
- Password complexity via `zod` regex: uppercase + lowercase + digit + min 8 chars.
- Rate limiting: 100 req/min global, 5 req/min on `/auth/*` (via `express-rate-limit` + `rate-limit-redis`).
- `helmet` + strict CORS allowlist (admin dashboard origin only — the Flutter app doesn't need CORS).

## Game engine (`src/modules/engine/`)

Pure module — no DB, no Socket.IO imports. See `00_MASTER_PROMPT.md` §3 for why this matters.

- `board.js` — board representation (standard 1–50 notation), helpers `squareToRowCol()` / `rowColToSquare()`
- `moves.js` — `getLegalMoves(board, color)`, `getCapturePaths(board, color)`, `getMaxCapturePaths(board, color)` (enforces the mandatory max-capture rule)
- `apply.js` — `applyMove(board, move) -> { newBoard, captured, promoted }`; multi-jump pieces are marked but only removed from the board array at the end of the full chained move
- `draws.js` — `isThreefoldRepetition(history)`, `isTwentyFiveKingMoveDraw(history)`, `canOfferDraw(moveCount)` (40-move minimum per player, per `01_PRODUCT_CONTEXT.md`)
- `checkGameEnd.js` — `checkGameEnd(board, history) -> { ended, reason, winner }`

**Required test fixtures (Jest) before any Socket.IO/Flutter integration:** single capture; forced max-capture choice between two paths; multi-jump chain (3+ pieces); king flying capture; threefold-repetition draw; 25-consecutive-king-move draw; no-legal-moves loss.

## Real-time (Socket.IO)

JWT verified on handshake (`socket.handshake.auth.token`). Room per match: `match:{matchId}`.

| Event | Direction | Payload |
|---|---|---|
| `join_match` | client → server | `{ matchId }` |
| `move_attempt` | client → server | `{ matchId, from, to }` |
| `move_applied` | server → both | `{ from, to, captured, promoted, nextTurn }` |
| `move_rejected` | server → sender only | `{ reason }` |
| `match_found` | server → both | matchmaking pairing result |
| `callout_created` | server → eligible online users | new call-out broadcast |
| `match_ended` | server → both | `{ winnerId, reason }` |
| `notification` | server → user | fired whenever `NotificationService.create()` runs and the user is online |
| `wallet_updated` | server → user | fired after any wallet balance change |

- Server holds authoritative board state in Redis (`match:{id}:board`); every move also writes a `MatchMove` row in Postgres for audit/reconnect. **Enable Redis AOF persistence** — live match state and money-staked matches living only in memory is not acceptable; see `07_ENGINEERING_STANDARDS_AND_OPERATIONS.md` §5 for the full recovery-path requirement (`rebuildBoardFromMoveLog(matchId)`).
- **Performance target: move round-trip (client `move_attempt` → both clients receive `move_applied`) under 100ms** under normal load — validated in Week 12 load testing per `06_BUILD_SEQUENCE.md`.
- `GET /matches/:id/state` — REST fallback for reconnect, returns current board state + move history (never rely on socket event buffer alone for resync).
- Disconnect handling: on disconnect, set `match:{id}:disconnect:{userId}` in Redis with 60s TTL. A `node-cron` job every 10s sweeps expired keys and triggers auto-forfeit + payout if the player hasn't reconnected.

## Matchmaking & call-outs

- Redis sorted sets, keyed `queue:{tier}:{stakeBucket}`, scored by join timestamp.
- `node-cron` worker every 3s pops compatible pairs, creates a `Match` row, emits `match_found`.
- `POST /callouts` — creates `Callout` (status `OPEN`), broadcasts `callout_created` to eligible online users per that tier's rules (see `01_PRODUCT_CONTEXT.md` — Amateur cannot call out or be called out).
- `POST /callouts/:id/accept` — wrapped in `SELECT ... FOR UPDATE` row lock to prevent a double-accept race; on success creates a `Match`, sets `Callout.status = ACCEPTED`.
- `GET /callouts/open` — open call-outs the requesting user is tier-eligible to accept.
- Tier/stake enforcement middleware (`tierEnforcement.js`) runs on every matchmaking and call-out endpoint. **Two different bounds, not one** — reads `PlatformSettings.{tier}StakeMinP/MaxP` for matchmaking/regular-play stakes, but reads the separate, higher `PlatformSettings.{tier}CalloutMaxP` when validating a call-out's stake amount (see `01_PRODUCT_CONTEXT.md` and `02_DATABASE_SCHEMA.md` for why these are intentionally different numbers — a call-out ceiling is meant to exceed the tier's normal stake range). Never trust a client-supplied stake without this server-side re-validation, and never validate a call-out against the matchmaking bounds by mistake.
- Call-out expiry — `node-cron` every minute sets `status = EXPIRED` where `expiresAt < now()` and still `OPEN`.

## Wallet & payments (Paystack primary, Flutterwave secondary — NGN, Phase 1)

**Payment abstraction — build this from day one, not as an afterthought:**
```
interface PaymentGateway {
  initiatePayment(amountMinorUnits, userId): { authorizationUrl, reference }
  verifyWebhookSignature(rawBody, signatureHeader): boolean
  processRefund(reference, amountMinorUnits): { success, refundReference }
}
class PaystackGateway implements PaymentGateway { ... }
class FlutterwaveGateway implements PaymentGateway { ... }
// StripeGateway implements PaymentGateway — stub only, not implemented until the Phase 2 global/GBP expansion
```
This mirrors the dual-gateway pattern already proven on the Tutaly project. Building it as an interface now — even with only two real implementations — is what makes the Phase 2 Stripe/GBP addition a new class instead of a rewrite.

- `POST /wallet/deposit-intent` — body includes a `gateway` choice (`paystack` | `flutterwave`); calls the corresponding `initiatePayment()`, returns the gateway's checkout/authorization URL for the Flutter app to open
- `POST /webhooks/paystack` — verifies `x-paystack-signature` (HMAC-SHA512) against the secret key; returns 401 on mismatch. On a successful charge event, credits `Wallet.balanceMinorUnits` and writes a `WalletTransaction` (`DEPOSIT`, `gateway: PAYSTACK`) in one Prisma `$transaction`. Fires `DEPOSIT_CONFIRMED`. Idempotency check — if the `gatewayReference` has already been recorded as `COMPLETED`, return 200 without reprocessing.
- `POST /webhooks/flutterwave` — identical flow, verifying the `verif-hash`/HMAC-SHA512 signature Flutterwave sends, `gateway: FLUTTERWAVE`.
- `POST /wallet/withdrawal-request` — creates a `WithdrawalRequest` (`PENDING`). **No auto-approval code path exists, by design**, regardless of gateway.
- Stake/payout — no external gateway call, purely internal: on match start, debit both players' stakes (Prisma transaction, `WalletTransaction` type `STAKE` each); on match end, credit winner `pot − commission` and write `PAYOUT` + `COMMISSION` transactions, all atomic alongside the `Match.status = COMPLETED` update. Commission percentage read live from `PlatformSettings.commissionPercent` — never hardcoded.
- `GET /wallet/balance`, `GET /wallet/transactions` (paginated), `GET /wallet/tier-limits` (returns the current tier's min/max stake so Flutter never hardcodes these).
- **Gateway wagering-eligibility is confirmed with both Paystack and Flutterwave** — settled as of Week 1, no further check needed before building the webhook handlers below.

## Notifications

`NotificationService.create(userId, type, title, message, link)` writes a `Notification` row and emits Socket.IO `notification` if the user is online; falls back to Firebase Cloud Messaging push (`firebase-admin`, using `User.fcmToken`) if offline.

Triggers to wire:
1. `DEPOSIT_CONFIRMED` — Paystack or Flutterwave webhook success
2. `WITHDRAWAL_APPROVED` / `WITHDRAWAL_REJECTED` — admin action
3. `CALLOUT_RECEIVED` — new eligible call-out
4. `CALLOUT_ACCEPTED` — to the challenger
5. `MATCH_FOUND` — matchmaking pairing
6. `MATCH_ENDED_WIN` / `MATCH_ENDED_LOSS` — with payout amount in the message
7. `DISCONNECT_WARNING` — grace period running low
8. `ACCOUNT_SUSPENDED` — admin ban action

- `GET /notifications` (paginated), `PATCH /notifications/:id/read`, `PATCH /notifications/read-all`. Unread count included in `GET /auth/me`.

## Security & anti-cheat

- Device fingerprint (client-built via `device_info_plus`, sent at login) compared against `DeviceFingerprint` — flag, don't auto-ban, accounts sharing a fingerprint across users.
- Basic IP/session anomaly logging (heuristic only — full fraud ML is out of MVP scope).
- Every `move_attempt` is re-validated server-side via the engine regardless of what the client displayed as "legal" — client-side legal-move highlighting is a UX convenience only, never trusted.
- TLS enforced in every environment, including staging.

## Admin module

- `GET /admin/users` (paginated, searchable, filter by tier/status), `PATCH /admin/users/:id/ban`, `PATCH /admin/users/:id/unban`
- `GET /admin/withdrawals` (pending queue), `PATCH /admin/withdrawals/:id/approve` (triggers a payout via whichever gateway — Paystack or Flutterwave — the user's wallet activity is associated with, updates status, writes `WalletTransaction`, fires `WITHDRAWAL_APPROVED`), `PATCH /admin/withdrawals/:id/reject` (with reason, fires `WITHDRAWAL_REJECTED`)
- `GET /admin/matches/live` — currently active matches for live monitoring
- `GET /admin/revenue` — total commission earned, breakdown by tier/day
- `PATCH /admin/settings/commission`, `PATCH /admin/settings/tier-limits` — updates `PlatformSettings`
- `POST /admin/disputes/:matchId/flag` — links to the `MatchMove` log for manual review
- **Every admin mutation writes an `AdminAuditLog` row in the same handler** — no exceptions.

## Global rules

- Global Express error handler — never leaks stack traces to the client; full detail goes to Sentry/logs only.
- `GET /health` — checks DB + Redis connectivity, used by UptimeRobot and load balancer health checks.
- All scheduled/periodic jobs (disconnect sweep, call-out expiry, matchmaking worker) use `node-cron` — one consistent mechanism for anything time-based, no mixing in a second job-queue library.