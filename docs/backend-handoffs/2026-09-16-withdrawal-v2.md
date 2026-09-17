# Backend handoff: Withdrawal V2 (PR 7)

Date: 2026-09-16
Branch: `refactor/backend-v2` (local only, not pushed)
Audience: frontend / Flutter wallet screen

## What changed

`POST /wallet/withdrawal-request` now goes through the new
`WithdrawalService` instead of the legacy inline withdrawal code.

- A **provider-verified bank account is now required** to request a
  withdrawal (see new bank-account endpoints below). `POST
  /wallet/withdrawal-request` returns **422** if the user has no verified
  destination yet.
- A withdrawal request **reserves** the funds in one atomic transaction:
  the wallet is debited immediately, the funds sit in
  `PLAYER_WITHDRAWAL_PENDING`, and the row is `PENDING_REVIEW`.
- A client-supplied `idempotencyKey` makes retries return the original
  request instead of a second reservation (replays are free and
  indistinguishable from the first call).
- Funds move out of the platform only after an admin approves the request
  and a provider payout confirms (admin console flow).

## Response shapes

`POST /wallet/withdrawal-request`

Request:

```json
{ "amountMinorUnits": 8000, "idempotencyKey": "op_<your-key>" }
```

`amountMinorUnits` is a canonical non-negative integer (minor units, e.g.
kobo). `idempotencyKey` is optional, 8–64 chars of `[A-Za-z0-9_-]`.

201 response — note `withdrawalRequest` is the exact key the app already
expects, `status` is now one of the V2 enum values:

```json
{
  "withdrawalRequest": {
    "id": "...",
    "status": "PENDING_REVIEW",
    "amountMinorUnits": "8000",
    "currency": "NGN",
    "reference": "wit-...",
    "gateway": "PAYSTACK",
    "createdAt": "2026-09-16T...",
    "updatedAt": "2026-09-16T..."
  }
}
```

Errors (JSON `{ "error": msg }`):
- `400` invalid amount or idempotency key
- `402` insufficient funds
- `403` account not KYC/eligibility-gated
- `422` no verified bank account / bank account not verified

`GET /wallet/withdrawals?page=1&limit=20&status=PENDING_REVIEW`

```json
{ "withdrawals": [ { "id": "...", "status": "PENDING_REVIEW", "amountMinorUnits": "8000", ... } ], "total": 1 }
```

## New bank-account endpoints

- `GET /wallet/bank-accounts` → `{ "bankAccounts": [ { "id", "gateway", "bankCode", "bankName", "accountNumber", "accountName", "isDefault", "verifiedAt", "createdAt" } ] }`
- `POST /wallet/bank-accounts` body:
  ```json
  { "gateway": "paystack", "bankCode": "057", "bankName": "Zenith", "accountNumber": "0123456789" }
  ```
  The account is resolved and registered with the provider **during this
  call** (a real account-resolution + recipient registration against the
  payment provider). 422 on provider failure, 400 on invalid shape. The
  returned `verifiedAt` is only set once the provider confirmed the account.
- `PATCH /wallet/bank-accounts/:id/default` → sets the default payout
  destination (used when a withdrawal does not specify one).
- `DELETE /wallet/bank-accounts/:id` → removes a destination (withdrawals
  already linked keep working; the stored `bankAccountId` is set null).

Recommended flow: user adds a bank account first, then requests a
withdrawal. The default destination is chosen automatically; you can also
invite the user to pick one.

## Socket event

`POST /wallet/withdrawal-request` emits `wallet_updated` to the user's
personal room:

```json
{ "balanceChange": "-8000", "type": "WITHDRAWAL" }
```

(the existing `wallet_updated` payload + `type: "WITHDRAWAL"`). An admin
release/refund additionally emits a positive `WITHDRAWAL_RELEASE` event.

## Status vocabulary (V2)

`PENDING_REVIEW → APPROVED → PROCESSING → COMPLETED | FAILED → RELEASED`

- `PENDING_REVIEW` funds are reserved, waiting for admin review.
- `APPROVED` reviewed; admin began no payout yet.
- `PROCESSING` a provider payout has been initiated (transfer in flight).
- `COMPLETED` payout confirmed — funds have left the platform; a
  `WITHDRAWAL_CONFIRMED` notification is created.
- `FAILED` the provider rejected/returned the payout; funds stay reserved
  until an admin retries or releases them.
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
  begin-payout, result-report, and reject actions; they require `isAdmin`.

## Verification

- `backend/scripts/verify/pr7-withdrawal.mjs` — 10/10 PASS (HTTP + Socket.IO
  probes incl. concurrent exit gate, idempotent replay, release exactly-once,
  closed-book zero-sum ledger).
- Full battery green: 38 unit suites / 277 tests, 10 integration suites /
  58 tests, pr5 10/10, pr6 16/16, pr7 10/10. Dev DB pristine.