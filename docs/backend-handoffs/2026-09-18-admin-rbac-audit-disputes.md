# Backend handoff: Admin, RBAC, audit & disputes (PR 11)

Date: 2026-09-18
Branch: `refactor/backend-v2` (local only, not pushed)
Audience: frontend / Flutter client (admin surfaces) and Citycod review

## Summary

The platform admin layer is now a real RBAC system. Authorization is
role-based and **DB-backed**: every admin request reloads the account's
`AdminRoleAssignment` rows, so granting or revoking a role binds across all
devices **immediately** (there are no JWT role claims to cache). Six roles are
seeded idempotently at startup; only `SUPER_ADMIN` can grant/revoke roles.

Every admin mutation (and every **denied** attempt) writes an immutable
`AdminAuditLog` row with the acting admin, action, outcome, target, IP,
user-agent and request id.

## Roles & permissions

| Role | Can do |
|---|---|
| `SUPER_ADMIN` | everything incl. `roles.admin` |
| `FINANCE` | withdrawals queue/approve/payout/reject, ledger adjustments, audit read |
| `RISK_COMPLIANCE` | KYC review, risk events/cases, safer-play lifts, audit read |
| `SUPPORT` | ban/unban, disputes, safer-play lifts, audit read |
| `GAME_OPERATIONS` | audit read (read-only) |
| `READ_ONLY_AUDITOR` | audit read + withdrawal visibility (read-only) |

A logged-in account with **no role** is `403` on every admin route and each
attempt is logged with `outcome: DENIED`.

## Admin endpoints (all need `Authorization: Bearer <token>`)

All admin routes additionally enforce a role-gate that maps onto these
permissions; the relevant roles are shown per group.

- `GET /admin/roles` (SUPER_ADMIN) → `{ roles: [{ name, description,
  permissions[], assignedCount }] }`; `GET /admin/users/:userId/roles`;
  `POST /admin/roles/assign` `{ userId, roleName }` → **201**;
  `POST /admin/roles/revoke`. Unknown role → **400** `RoleAssignmentError`.
- `GET/POST /admin/withdrawals…` (FINANCE): `GET /admin/withdrawals
  ?status=&page=&limit=`, `POST …/:id/approve`, `POST …/:id/begin-payout`
  (**422** `BankAccountRequiredError` / `PaymentGatewayError`),
  `POST …/:id/report-result { success, failureReason }`,
  `POST …/:id/reject { reason }` (funds auto-released).
- KYC (RISK_COMPLIANCE): `GET /admin/verification-cases ?status=`,
  `POST …/:id/approve` / `…/:id/reject { reason }` → approving a `PENDING`
  case flips the player's `kycStatus` to `VERIFIED`; **409**
  `VerificationCaseNotReviewableError` once decided; `{ replayed }` is true
  on idempotent retry.
- Disputes (SUPPORT): `GET /admin/disputes ?status=`,
  `POST …/:id/evidence { type, url, description? }` (**400** on bad type/url,
  **404** unknown case), `POST …/:id/decide { status: RESOLVED|DISMISSED,
  resolution }` (**409** if already decided). Evidence types:
  `SCREENSHOT|CHAT_LOG|GAME_LOG|SYSTEM_LOG|OTHER`.
- Risk (RISK_COMPLIANCE): `GET /admin/risk-events ?type=&severity=&userId=`,
  `GET /admin/risk-cases ?status=`, `POST …/risk-cases/:id/status
  { status, assignedTo? }`.
- Ledger (FINANCE): `POST /admin/ledger/adjustments
  { userId, amountMinorUnits, direction: CREDIT|DEBIT, reason?, reference }`
  → **201** `{ adjustment: { transactionId, available } }`; **422**
  `InsufficientFundsError` when a DEBIT exceeds available funds. The
  adjustment is a **balanced, double-entry, idempotent** ledger transaction
  (money + `CUSTOMER_LIABILITY` in mirror), keyed by `reference` — replaying
  the same `reference` returns the original transaction unchanged and does not
  double-post.
- Safer-play lifts (RISK_COMPLIANCE / SUPPORT):
  `POST /admin/safer-play/:userId/clear-timeout` and
  `POST …/end-self-exclusion` → `{ lifted, profile }` (**404** unknown user).
- Audit (any non-read-only role via `audit.read`): `GET /admin/audit/logs
  ?page=&limit=&outcome=&action=&targetUserId=`. Rows:

  ```
  { id, adminId, action, outcome: "SUCCESS"|"DENIED", targetType, targetId,
    metadata, ip, userAgent, requestId, createdAt }
  ```

## Account status (SUPPORT)

`PATCH /admin/users/:userId/ban` and `…/unban`. A ban:
- revokes the account's refresh tokens via Redis **and** sets the DB flag, so
  a banned user's **existing and fresh sessions** both get **401** immediately;
- disconnects live sockets (`disconnectSockets`) so a banned session stops
  receiving events; safe when the socket layer is not running; and
- is reversible with `…/unban` — the player signs in again and plays normally.

## Client / frontend guidance

- Any admin/ops console should gate its UI on the same matrix above. There is
  no per-user "my roles" endpoint by design; a console can call
  `GET /admin/audit/logs` to probe read access and treat **403** as "no role /
  not permitted" (`{ error }`, plus a matching `DENIED` audit row server-side).
- Denials are `403`; missing targets are `404`; state conflicts are `409`;
  invalid input is `400`; money-flow conflicts surface as `422`. All response
  bodies are `{ error: "<message>" }` on failure.
- KYC admin approve is the only path that flips a player to `VERIFIED`
  (the player-facing `/verification/start` preview never writes state).
- Rejecting a `report-result` / `reject` withdrawal auto-credits the player —
  surface the new balance from the existing `wallet_updated` socket event.
- `role.assign` / `role.revoke` bind immediately; no logout/relogin needed.

## Deep verification

`backend/scripts/verify/pr11-admin-rbac.mjs` drives the real HTTP app +
PostgreSQL + Redis and asserts 8 checks: 403-elsewhere for a no-role account
(+DENIED audit), auditor read-only, FINANCE queue + balanced/idempotent credit
+ overdraw 422, SUPPORT ban binding on a fresh session + dispute
evidence/decide/409, RISK_COMPLIANCE KYC approve, instant grant **and** revoke
across fresh sessions, closed-book net-zero ledger, and an audit trail holding
both successes and denials. **8/8 pass, twice in a row**, and it leaves zero
rows behind (self-cleaning; re-run on a clean DB verified).

Battery on a wiped DB: **48 unit suites / 414 tests** green (RBAC 15, audit 8,
admin 19, ledger 18 + auth/verification/saferPlay updated), then **11
integration suites / 72 tests** green (admin 11, refresh 3, callout 6,
depositIntent 11, withdrawal 8, activeMatchReservation 5, gameActivation 4,
ledger 4, durableMoveLog 6, settlement 10, timeControl 4). DB and Redis were
wiped again after the battery, so the repo is left pristine.