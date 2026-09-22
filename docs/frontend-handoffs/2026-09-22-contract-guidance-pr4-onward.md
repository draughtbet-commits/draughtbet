# Frontend Contract Guidance — PR 4 (match lifecycle) and beyond

- Date: 2026-09-22
- Recipient: Citycod (frontend / Flutter client)
- Authoritative sources (consult these, not cached copies):
  1. **The deployed backend** is the local `refactor/backend-v2` (`0883d38`), NOT
     `origin` — origin lacks the V2 protocol modules (gameProtocol, outbox,
     matchmaking). All contracts below were read from the deployed source.
  2. `docs/backend-handoffs/2026-09-17-game-protocol-v2.md` (wire protocol, PR 8).
  3. `backend/src/sockets/index.js`, `backend/src/sockets/gameProtocol.js`,
     `backend/src/sockets/disconnectHandler.js`, `backend/src/modules/callout/*`,
     `backend/src/modules/matchmaking/*`.

- Rule: **the wire contract is the deployed backend's registration lists below.**
  If a name is not on those lists, the app must not send or expect it.

---

## 1. Client → server socket events (verified handlers on deployed backend)

Registered in `backend/src/sockets/index.js` (see the source for payload guards):

| Event | Payload | Handler |
|---|---|---|
| `join_match` *(legacy)* | `{ matchId }` | `handleJoinMatch` |
| `match.join` | `{ matchId }` | `handleJoinMatch` |
| `move_attempt` *(legacy)* | `{ matchId, from, to }` | `handleMoveAttempt` |
| `move.submit` | `{ matchId, clientMoveId, expectedStateVersion?, from, to?, path? }` | `handleMoveSubmit` |
| `resign` *(legacy)* | `{ matchId }` | `handleResign` |
| `match.resign` | `{ matchId, actionId?, expectedStateVersion? }` | `handleResign` |
| `clock.sync` | `{ ... }` (server clock sync) | `handleClockSync` |

**NOT registered — must be removed from the app:** `draw.offer`, `draw.respond`.
There is no draw protocol in the deployed backend or in any handoff doc. Sending
these is a silent no-op (move/game still proceeds on the server, client thinks a
draw was requested).

---

## 2. Server → client socket events (what the app may listen to)

| Event | Shape | Notes |
|---|---|---|
| `match.state` | canonical resync `{ matchId, version, board[], currentTurn, currentTurnUserId, status, winnerId, moveCount, deadlineAt, timeControlSeconds, turnStartedAtServer, serverNowMs, remainingMs, disconnectGraceMs, legalMoves[] }` | **The only payload a client should parse as game state.** Emitted on `match.join`/`join_match` and alongside `move.rejected`/`stale_state`. |
| `game_state` | LEGACY raw Redis hash: `board` is a JSON **string**, **no `status` field** | Preserved only for the old client. Do **not** feed this to `GameState.fromJson` — it throws (`board` string cast + missing `status`). Drop the listener or guard it. |
| `move.accepted` | `{ matchId, clientMoveId, version, stateVersion, move:{from,to,path,captured,promoted}, nextTurn, gameEnded, reason, legalMoves, board[], replayed }` | Same stream as `move_applied`. |
| `move.rejected` | `{ code, expectedStateVersion?, currentVersion? }` | Richer V2 payload. Legacy `move_rejected` is `{ reason }` only. |
| `move_applied` *(legacy)* | as in `game-protocol-v2.md` | legacy, still emitted |
| `move_rejected` *(legacy)* | `{ reason }` | legacy, still emitted |
| `match_ended` | settlement result + payout truth | PR 5 scope |
| `match_ended_resign` | `{ winnerId, resignedId }` | |
| `opponent_disconnected` | `{ userId }` | |
| `opponent_reconnected` | `{ userId }` | |
| `match_found` | match payload, emitted to BOTH players' `user:${id}` rooms | |
| `callout_created` | broadcast `{ ...callout }` | |
| `notification` | | |
| `wallet_updated` | **underscore only.** `{ balanceChange, ... }` from the outbox | |
| `error` | `{ message, retryAfterMs? }` | |

**NOT emitted by the deployed backend — remove these listeners:**
`match.finished`, `draw.offer`, `draw.responded`, `wallet.updated` (dot).

> Note: `wallet.updated` (dot) appears once in
> `docs/backend-handoffs/2026-09-18-kyc-eligibility-safer-play.md:95` — that is a
> typo. The outbox docs and deployed backend use `wallet_updated`. Fix that line.

---

## 3. PR 4 scope — match lifecycle UI (DB-MATCH-006..029)

As landed, PR 4 is presentation-only: `match_lifecycle_screens.dart` renders a
prebuilt `MatchLifecycleSnapshot`; there are no API/socket calls from those
screens. When wiring them, use only the events/endpoints above.

REST endpoints (all verified against the deployed backend):

| Endpoint | Shape | Notes |
|---|---|---|
| `GET /callouts/open` | `{ callouts: [ { id, challengerId, challenger:{ displayName, username?, avatar?, rating?, tier? }, stakeMinorUnits (STRING), tier, status, expiresAt, timeControl?, gameType?, board? } ] }` | `match_flow_gateway.dart` parses this correctly. `challenger.name` fallback chain is fine. |
| `POST /callouts` | body `{ stakeMinorUnits }` | |
| `POST /callouts/:id/accept` | | handoff is driven by the `match_found` socket event, not the response body |
| `GET /matches/history` | | |
| `GET /matches/:id/state` | `{ matchId, board (array), currentTurn, status, winnerId, moveCount, ... }` | controller JSON-parses the board; OK for the strict model |
| `POST /matchmaking/join` | body `{ stakeMinorUnits }` → `{ status: 'queued', queueKey }` | bucket `queue:${tier}:${stakeMinorUnits}`; 409 if a preterminal match exists |
| `POST /matchmaking/leave` | | |
| `GET /wallet/balance` | `{ balance: { currency, balanceMinorUnits, lockedMinorUnits, pendingMinorUnits } }` | stake reservation moves funds AVAILABLE→LOCKED; `wallet_updated` fires; UI shows the locked card |
| `GET /wallet/locked` | | locked funds detail |

### PR 4 checklist — patch these in the app:
1. `socket_service.dart`: remove the `draw.offer` / `draw.respond` emitters and the
   `draw.offer` / `draw.responded` / `match.finished` listeners; keep
   `join_match`, `move.submit`, `move_attempt`, `match.resign`, `resign`,
   `clock.sync` emitters and `match.state`, `move.accepted`, `move.rejected`,
   `move_applied`, `move_rejected`, `match_ended`, `match_ended_resign`,
   `opponent_*`, `match_found`, `callout_created`, `notification`,
   `wallet_updated` (underscore), `error` listeners.
2. `socket_service.dart`: remove the `wallet.updated` (dot) listener.
3. Reconnect/resync: the join handler emits BOTH `match.state` (canonical,
   protocol v2) and legacy `game_state`. Route the app onto `match.state` and do
   NOT parse `game_state` with `GameState.fromJson` (throws: `board` string + no
   `status`). Either drop the `game_state` listener or filter by the
   `_protocolVersion: 2` marker that `match.state` carries.
4. `models/game_state.dart`: if the strict model stays (`required List<int> board`,
   `required String status`), add defaults in the normalizer so a legacy payload
   can never throw — but the correct fix is (3).

---

## 4. PR 5 — settlement result UI (`ui/pr5-settlement-ui`)

Reviewed 2026-09-22.

### App data paths (as written)
- `SettlementGateway.fetchStatus` → `GET /settlements/{matchId}`
- `SettlementGateway.fetchReceipt` → `GET /matches/{matchId}/receipt`
- `match_provider.onMatchEnded` → `MatchResultViewData.tryFromServer(match_ended socket data)`

### Contract facts
- Documented wallet/match REST surface (see `docs/backend-handoffs/`): no `/settlements/*`,
  no `/matches/:id/receipt` — these were never part of any contract.
- `match_ended` socket payload is exactly `{ winnerId, reason, payout }`.
- The result-view inputs that DO exist: `GET /matches/history` + `GET /wallet/transactions`
  (details in Findings).

### Findings
**(A) Frontend — must be patched (hand to citycod):**
1. `GET /settlements/{matchId}` and `GET /matches/{matchId}/receipt` are **not part of the
   documented contract** (no such routes anywhere in `docs/backend-handoffs/`). Do not build
   the result screen against endpoints that don't exist.
2. Documented path for settlement truth — use it instead:
   - `match_ended` socket `{ winnerId, reason, payout }` is a **live trigger only**
     (set `settling`, set `endReason` from `reason`).
   - `GET /matches/history` returns per match: `id`, `playerLight`/`playerDark` `{id, username}`,
     `tier`, `stakeMinorUnits`, `status`, `winnerId`, `endReason`, `createdAt`, `endedAt`.
     From this the app derives: result kind (winnerId null → draw; ==self → victory; else defeat;
     `endReason` for timeout/resign/forfeit), opponent, terms, settled time.
   - Payout/refund comes from `GET /wallet/transactions` (ledger `SETTLEMENT_PAYOUT` / `REFUND`)
     — already wired via the PR 3 feed.
   - Rebuild `MatchResultViewData` from these two documented reads; do not parse `match_ended`
     for the view (it has no `kind`/`opponent` and never will — that isn't in the contract).
3. Consequence of the current code: `tryFromServer(match_ended)` always returns `null` →
   `authoritativeResult` stays null, settlement sticks `pending`, active match never cleared,
   result screens unreachable (router redirects home). The fix is (2).
4. `MatchReceiptData` as written expects fields (`reference`, `settledAt`, `resultKind`,
   `opponent`, `terms`) no documented route returns — build the receipt view from the same
   documented pair (`matches/history` + `wallet/transactions`), or drop the receipt feature
   until product defines a receipt contract.

---

## 5. PR 6 — deposit flow UI (`ui/pr6-deposit-ui`)

Reviewed 2026-09-22.

### App data paths (as written)
- `DepositGateway.createQuote` → `POST /deposits/quote` `{ amountMinorUnits }`
- `DepositGateway.createIntent` → `POST /wallet/deposit-intent`
  `{ amountMinorUnits, gateway, quoteId?, idempotencyKey? }`
- `DepositGateway.fetchStatus` → `GET /deposits/{reference}`
- Post-checkout recovery: persist reference, resume poll via `fetchStatus` with backoff.

### Contract facts (documented wallet surface, `docs/backend-handoffs/`)
- `POST /wallet/deposit-intent` — documented and live: body `{ amountMinorUnits, gateway }`
  with `gateway` ∈ exactly `paystack` | `flutterwave`; returns `{ authorizationUrl,
  reference }`. Eligibility + safer-play gates enforced server-side.
- `GET /wallet/transactions` — documented ledger feed (deposit entries appear on credit).
- `wallet_updated` socket — documented outbox push on balance change.
- No `/deposits/*` routes are part of any contract — `POST /deposits/quote` and
  `GET /deposits/{reference}` do not exist.

### Findings
**(A) Frontend — must be patched (hand to citycod):**
1. `POST /deposits/quote` → 404. The quote step blocks the whole flow (`requestQuote`
   errors "Deposit options are unavailable…"). On the deployed backend **the quote and the
   initiation are one call**: `POST /wallet/deposit-intent` returns the checkout URL. Drop the
   separate quote phase (and the quoted `paymentMethods` selection that reads from it), or
   gate the UI on what `deposit-intent` returns.
2. `GET /deposits/{reference}` → not in the contract. Post-checkout polling and session
   recovery are dead; `DepositStatus` never advances past `pending`. Reconcile instead from
   the documented path: outbox pushes `wallet_updated` over socket → the app already refreshes
   balance + `GET /wallet/transactions` (PR 3 wiring). Mark the deposit successful when its
   entry lands as `COMPLETED` in the feed.
3. `createIntent` sends `gateway: method.id` — must be exactly `paystack` or `flutterwave` or
   the backend 400s. `quoteId`/`idempotencyKey` are ignored by the endpoint (harmless if kept).
4. Keep using `authorizationUrl` from `deposit-intent` in `CheckoutWebviewScreen` for the
   redirect — that half matches the contract already.

---

## 6. PR 7–8 (append as each PR is reviewed)

- PR 7 — withdrawal flow UI (`ui/pr7-withdrawal-ui`)
- PR 8 — game protocol UI (`ui/pr8-game-protocol-ui`)
- WIP — `ui/pr4-pr8-contract-alignment` (top of the stack, carries the socket/model
  wiring above)

---

## 7. WS1 route versioning — `/api/v1` prefix + `/auth/me` → `/me` (2026-09-22)

Backend moved every REST route under `/api/v1` (webhooks + `/health` + `/ready` stay
unversioned). The shared Flutter Dio base URL in `lib/services/api_client.dart` now
appends `/api/v1` automatically, so all provider/service calls that route through
`apiClientProvider` work unchanged. Socket.io still uses the raw host (correct —
realtime is unversioned).

Completed on the app side (no further action needed):

- `lib/services/api_client.dart` — base URL versioned to `/api/v1`; `_authPaths`,
  refresh retry, and `_refreshClient` reuse the same versioned base.
- `lib/providers/profile_provider.dart` — `GET/PATCH /auth/me` → `/me`.

Remaining screen-inline call (citycod to fix — uses the shared Dio so only the
literal path is stale):

- `lib/screens/settings_screen.dart:63` — `dio.get('/auth/me')` → `'/me'`.

---

## Verification (what the reviewer will check on the next push)

- `grep -rnE "draw\.offer|draw\.respond|match\.finished|wallet\.updated" app/lib` → **zero hits**.
- `game_state` no longer parsed with the strict `GameState.fromJson` (or `match.state` is the only state source).
- Backend docs + deployed backend agree on every event name an app screen uses.
- App test suite + `flutter analyze` green; PR harnesses (`pr3`–`pr8`) pass against the deployed backend.