# Backend handoff: KYC, eligibility & safer-play (PR 10)

Date: 2026-09-18
Branch: `refactor/backend-v2` (local only, not pushed)
Audience: frontend / Flutter client (withdrawal + match flows) and Citycod review

## Summary

KYC, account-eligibility and the safer-play controls are now enforced
**server-side and DB-backed**, so every restriction binds across all of a
player's devices at once. The rules live in one central
`EligibilityService`; the payment and match flows call it at the exact moment
they act (money-in, money-out, queue join, call-out, match funding).

**Policy change:** verified KYC is required for **money-OUT only**
(`POST /wallet/withdrawal-request`). Deposits, matchmaking, match and call-out
creation no longer require KYC (they never should have). A `VERIFIED`
`kycStatus` is projected onto the user from the last passing verification case.

## New endpoints (all require `Authorization: Bearer <token>`)

### `/verification`
- `POST /verification/start` → **201** `{ status: "VERIFIED", caseId, checkId }`
  when the (simulated) provider passes; **422** when it rejects
  (`{ error }` with `KycRejectedError` message); **409** when already verified
  or a case is in-flight; **400** for an unsupported `type`.
  Body: `{ type }` — one of `ID_DOCUMENT | SELFIE | PROOF_OF_ADDRESS | BVN | NIN`.
  Outcome is driven by `SIMULATED_KYC_RESULT` (`pass` default, `fail`);
  a real provider adapter (Dojah / Flutterwave-KYC) slots in later with no
  wire-contract change.
- `GET /verification/status` → **200**
  ```
  { kycStatus: "NONE" | "PENDING" | "VERIFIED",
    case: { id, status, provider, createdAt, updatedAt,
            checks: [{ id, type, status, verifiedAt }] } | null }
  ```
  The same `VERIFIED` projection is returned from any device immediately after
  a pass (server-owned, DB-backed).

### `/safer-play`
- `GET /safer-play/profile` → **200** `{ profile }` (or `profile: null`).
  `profile`:
  ```
  { depositLimitMinorUnits, pendingDepositLimitMinorUnits,
    pendingDepositLimitRaisedAt, effectiveDepositLimitMinorUnits,
    stakeLimitMinorUnits, pendingStakeLimitMinorUnits,
    pendingStakeLimitRaisedAt, effectiveStakeLimitMinorUnits,
    timeoutUntil, selfExcludedUntil }
  ```
  Effective values are what actually binds; a pending RAISE is staged but not
  yet effective. All money fields are **string** minor units (never floats).
- `PUT /safer-play/deposit-limit` and `PUT /safer-play/stake-limit`
  Body `{ amountMinorUnits }` (string) or empty/null → clear the limit.
  **Setting or lowering applies immediately**; **raising stages a pending
  raise that only becomes effective after a 24h cooling window** (soon an
  admin-editable platform setting). Returns the updated `{ profile }`. **400**
  for an invalid amount.
- `POST /safer-play/timeout` body `{ minutes }` → **201**. Temporary break:
  blocks matchmaking/call-outs/staking until the chosen time. **Extend-only** —
  a shorter timeout is **409** (`TimeoutShrinkError`). **400** for invalid
  `minutes`.
- `POST /safer-play/self-exclusion` body `{ until }` → **201** (`until` is
  `<n>d` or an ISO date). Hard block on **everything** (deposits, withdrawals,
  play). **Extend-only** — shortening is **409** (`SelfExclusionShrinkError`);
  ending a self-exclusion is admin-only (deferred to the admin milestone).
  **400** for invalid `until`.

## Safer-play rules (server-enforced)

| Control | Sets on one device | Binds on another device too |
|---|---|---|
| Deposit limit (rolling 24h, completed intents) | yes | yes — 422 `DepositLimitExceededError` on `POST /wallet/deposit-intent` |
| Stake limit (per match) | yes | yes — 422 `StakeLimitExceededError` on join / call-out / funding |
| Timeout | yes | yes — 403 `TimeoutActiveError` on joins / call-outs / funding |
| Self-exclusion | yes | yes — 403 `SelfExcludedError` on deposits, withdrawals, play |
| KYC (money-out) | verified once | yes — 403 `KycRequiredError` on `POST /wallet/withdrawal-request` until `VERIFIED` |

Error bodies are `{ error: "<human message>" }`; HTTP codes are stable
(400 invalid input, 403 account/eligibility/KYC/timeout/self-exclusion, 409
extend-only conflicts and already-verified, 422 limit exceeded or rejected
KYC).

## Client guidance

- Show the safer-play profile whenever a limit or break is active; prefer
  `effective*` when presenting a limit and show the pending raise + its
  `pendingDepositLimitRaisedAt` as "change comes into effect <time>".
- `POST /wallet/withdrawal-request` may now fail with **403 KycRequiredError**;
  route the player to `/verification/start`, then retry after a **201**.
  The withdrawal flow otherwise keeps its current request/accept/complete
  contract (money auth unchanged).
- Tolerate new **409/422** responses on matchmaking/call-out endpoints — a
  timeout, self-exclusion or stake limit supersedes tier presets.
- No new socket events; wallet updates still arrive via the existing
  `wallet.updated` outbox/channel.

## Deep verification

`backend/scripts/verify/pr10-eligibility-safer-play.mjs` drives the real HTTP
app + PostgreSQL + Redis and asserts all of the above across two devices per
account (8/8 pass; the ledger stays net-zero and no test rows are left behind).
Battery: **55 suites / 417 tests green**.