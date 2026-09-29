# Backend handoff: Withdrawal V2 (PR 7)

Date: 2026-09-16
Revised: 2026-09-28
Branch: `refactor/backend-v2` (local only, not pushed)
Audience: frontend / Flutter wallet screen

> **PARTIALLY SUPERSEDED — read the section below before building anything.**
> The route paths and socket event in the rest of this document are the
> **legacy** `/wallet/*` surface. The app must use the frozen V2 contract in
> `New Folder/Draught_Bet_Backend_Master_Package_v1/02_API_and_Realtime/`.
> The status vocabulary further down is still correct and matches the contract.

## Current V2 contract (authoritative)

Source of truth:
`02_API_and_Realtime/draught-bet-openapi-v1.yaml` and
`draught-bet-socket-contract-v1.md`.

| Purpose | Endpoint | Notes |
|---|---|---|
| Eligibility gate | `GET /me/eligibility?action=WITHDRAW&amount={minorUnits}` | §4. Returns `{allowed:true, requirements}`. A block is a **403/422 body**, not a transport error — read it. |
| List destinations | `GET /me/bank-accounts` | §2. Returns full account numbers; see gaps. |
| Add/verify destination | `POST /me/bank-accounts` | §2. Body is `bankCode` + `accountNumber` only. `Idempotency-Key` header required. The bank **name is server-derived**. |
| Request payout | `POST /withdrawals` | §6. Body is `{ amountMinor, bankAccountId }`. `Idempotency-Key` header **required** (not a body field). |
| Poll payout | `GET /withdrawals/{withdrawalId}` | §6. Resolves on the row **`id`**. The `wit-…` reference is display-only and 404s here. |

There is **no** withdrawal quote, fee, net-amount or balance endpoint, and
**no** withdrawal list endpoint. The socket contract defines no
`withdrawal.*` lifecycle event — the only adjacent event is `wallet.updated`
(`availableMinor, lockedMinor, withdrawalPendingMinor, reason`), which is a
**hint** to re-read status, not a status source. Polling
`GET /withdrawals/{id}` is the supported mechanism.

Gate codes that map to a screen:
`KycRequiredError` | `EligibilityRequiredError` | `AgeNotVerifiedError` →
verification required. Any other 403 (self-exclusion, break, ban) is **not** a
verification problem and must not be presented as one.

## Known gaps (as of 2026-09-28, after the backend remediation pass)

**Resolved in this pass**

1. `GET /me/limits` is now **implemented** and returns the real
   deposit / stake / timeout / self-exclusion values from the
   `SaferPlayProfile` row. `withdrawal.limitMinorUnits` is `null` with
   `enforced: false` because **no withdrawal limit exists**. No limit
   figure may be displayed until policy defines one.
2. `GET /me/eligibility?action=WITHDRAW` now returns
   `withdrawal_amount: "not_evaluated"` in its requirements instead of
   implying the amount was checked. It is **not** amount-gated.
3. Player-facing bank-account payloads now return `maskedAccountNumber`
   only. Full account numbers stay in the database and at the provider;
   the payout path uses the provider recipient code, so masking is safe.
4. `POST /withdrawals` and `POST /me/bank-accounts` return **200**, matching
   the OpenAPI.
5. `POST /wallet/withdrawal-request` is **removed**. Money can now only
   leave the platform through contract §6, which requires a
   provider-verified destination and an `Idempotency-Key` header. The
   removal reason is recorded in `src/modules/wallet/controller.js`.

**Bugs found and fixed while verifying**

6. `POST /withdrawals` read the body field `amountMinor` while every other
   money route (and the old legacy route) used `amountMinorUnits`. A client
   following the established convention got a silent "Invalid amount". Now
   reads `amountMinorUnits`.
7. `POST /withdrawals` returned `{ data: { withdrawal } }` while
   `GET /withdrawals/{id}` returned a bare `{ withdrawal }`. Both now use
   `{ data: { withdrawal } }`. The app parses both and is unaffected.
8. An ineligible player attempting a withdrawal received **500** instead of
   **403**: `POST /withdrawals` never mapped the eligibility errors
   (`AgeNotVerifiedError`, `CountryNotAllowedError`, `KycRequiredError`,
   `EligibilityRequiredError`, `AccountRestrictedError`, `SelfExcludedError`)
   that the old legacy route mapped. Fixed in the controller.

**Still open**

9. The bank-account endpoints are implemented but **still missing from the
   OpenAPI**.
10. `PATCH /me/limits` is in the OpenAPI but **not implemented**; no safe
    generic patch semantics were defined, so it was left alone.
11. The `/wallet/*` list and bank-account routes remain live alongside V2.
    Only the money-out duplicate was removed.
12. The DB integration suites are not isolated from each other. They share
    one database and the `CUSTOMER_LIABILITY` singleton, so a full-suite run
    fails tests that pass individually on a clean database. Pre-existing and
    unrelated to this work; it needs per-suite isolation or serialisation.

## The withdrawal create surface

`POST /withdrawals` (contract §6) is the only way to move money out.

Request — `Idempotency-Key` **header** is required (8–128 chars of
`[A-Za-z0-9._:-]`), and `bankAccountId` may be omitted to use the player's
default verified destination:

```json
{ "amountMinorUnits": 8000, "bankAccountId": "bank_..." }
```

`amountMinorUnits` is a canonical non-negative integer (minor units, e.g.
kobo). 200 response, the same envelope as `GET /withdrawals/{withdrawalId}`:

```json
{
  "data": {
    "withdrawal": {
      "id": "...",
      "status": "PENDING_REVIEW",
      "amountMinorUnits": "8000",
      "currency": "NGN",
      "reference": "wit-...",
      "gateway": "PAYSTACK",
      "bankAccountId": "...",
      "createdAt": "2026-09-16T...",
      "updatedAt": "2026-09-16T..."
    }
  }
}
```

`withdrawalId` in `GET /withdrawals/{withdrawalId}` is the database row
`id`. The `wit-...` reference is display-only and must never be used for
status polling.

Errors (JSON `{ "error": msg }`):
- `400` invalid amount
- `402` insufficient funds
- `403` account not KYC/eligibility-gated (age, country, self-exclusion, ban)
- `404` unknown bank account
- `422` no verified bank account / bank account not verified

**Concurrency note:** creates go through the HTTP idempotency layer, so two
genuinely simultaneous requests with the same `Idempotency-Key` return one
`200` and one `409`. The loser never reaches the service, so there is no
second debit.

## Bank-account endpoints

- `GET /me/bank-accounts` and `GET /wallet/bank-accounts` →
  `{ "bankAccounts": [ { "id", "gateway", "bankCode", "bankName", "maskedAccountNumber", "accountName", "isDefault", "verifiedAt", "createdAt" } ] }`
  — `maskedAccountNumber` only; no raw number is ever returned.
- `POST /me/bank-accounts` body (requires `Idempotency-Key`):
  ```json
  { "bankCode": "057", "bankName": "Zenith", "accountNumber": "0123456789" }
  ```
  `bankName` is resolved server-side from the code when omitted. The account
  is registered with the provider during this call. 400 on invalid shape,
  422 on provider failure. `verifiedAt` is set only once the provider
  confirmed the account.
- `PATCH /wallet/bank-accounts/:id/default` — sets the default payout
  destination (used when a withdrawal does not name one).
- `DELETE /wallet/bank-accounts/:id` — removes a destination (withdrawals
  already linked keep working; the stored `bankAccountId` is set null).

## Wallet socket events

The contract event is `wallet.updated` (dot-separated):

```json
{ "availableMinor": 2000, "lockedMinor": 0, "withdrawalPendingMinor": 8000, "reason": "WITHDRAWAL" }
```

The **authoritative** signal is that projection. A withdrawal reserve shows
the reduced `availableMinor` and a non-zero `withdrawalPendingMinor`; a
release shows the funds back in `availableMinor` and
`withdrawalPendingMinor: 0`.

The legacy `wallet_updated` (underscored) alias is still emitted for older
clients, but it carries only `balanceChange`, `type` and `matchId` — **no
projection**. Do not build a balance from `balanceChange`: it is an unsigned
magnitude in current practice, so a withdrawal can report it as positive.
Listen to `wallet.updated` and read the projection.

## Status vocabulary (V2)

`PENDING_REVIEW → APPROVED → PROCESSING → COMPLETED | FAILED → RELEASED`

- `PENDING_REVIEW` funds are reserved, waiting for admin review.
- `APPROVED` reviewed; admin began no payout yet.
- `PROCESSING` a provider payout has been initiated (transfer in flight).
- `COMPLETED` payout confirmed — funds have left the platform; a
  `WITHDRAWAL_CONFIRMED` notification is created.
- `FAILED` the provider rejected/returned the payout; funds stay reserved
  until an admin retries or releases them. **This is not a refund and not
  terminal** — it needs its own screen. Rendering it as "reversed" told
  players their money was back while it was still held. Keep polling and keep
  the row `id` persisted so an admin retry is picked up.
- `RELEASED` the withdrawal was rejected/refunded; the reserved funds
  returned to the wallet and a `WITHDRAWAL_REFUNDED` notification fires.

The app can treat any of `PENDING_REVIEW | APPROVED | PROCESSING | FAILED`
as "withdrawal in progress" (money is held), and `COMPLETED | RELEASED`
as terminal.

## Other notes

- `GET /wallet/balance` response shape is unchanged, but as of the PR 3 read-flip
  (2026-09-17) its value is the V2 ledger `PLAYER_AVAILABLE` net rather than the
  legacy `Wallet.balanceMinorUnits` column (which has been dropped). See
  `docs/backend-handoffs/2026-09-17-readflip.md`.
- The outbox / ledger mirroring behind all of this is transparent to the
  app; no new header or auth requirement on these endpoints.
- Admin-only routes (`/admin/withdrawals*`) power the console review,
  begin-payout, result-report, and reject actions. `isAdmin` alone is **not**
  enough: they are RBAC-gated on `withdrawals.process`, so an operator needs a
  role assignment (e.g. `FINANCE`) or they get 403.

## Verification

- `backend/scripts/verify/pr7-withdrawal.mjs` — **22/22 PASS**, repeatable.
  Self-hosts the routers, so it needs a live PostgreSQL but no separate server.
  Covers the exit gate, idempotent replay, the 402/403/422 refusals, the
  webhook lifecycle, RBAC'd admin transitions, socket projections and the
  closed-book zero-sum ledger.
- `backend/scripts/verify/pr10-eligibility-safer-play.mjs` — **8/8 PASS**.
  Boots the real app, so it needs PostgreSQL and Redis.
- Backend unit suites: **72 passed / 15 skipped, 699 tests passed**.
- App suite: **233/233 passed**.
- `pr7-withdrawal.mjs` seeds the admin roles itself (`ensureRoles`). The app
  does that on boot, but pr7 mounts routers directly, so without it every
  RBAC'd admin call fails on a freshly reset database.
- Both verify scripts namespace their `Idempotency-Key` per run. The HTTP
  idempotency claim is keyed `scope+method+path+key` with no user in it, so a
  fixed key silently replays the *previous* run's cached response and looks
  like a passing no-op. Cleanup deletes the run's claims.
- The integration suites are not mutually isolated — see open gap 12. They
  pass individually on a freshly reset database.