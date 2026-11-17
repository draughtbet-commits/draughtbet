# PR7 Withdrawal UI vs Backend V2 audit

Date: 2026-09-27

## Decision

PR7 is visually implemented but is not production-contract aligned. The live
Flutter flow cannot reach withdrawal submission, its REST paths and payloads do
not match Backend V2, and `FAILED` is incorrectly presented as a terminal
refund/reversal.

## Contract-critical findings

1. The Dio client already uses an `/api/v1` base URL, but the withdrawal
   gateway adds `/api/v1` again and targets routes which do not exist. Backend
   V2 exposes `/wallet/bank-accounts`, `/wallet/withdrawal-request`, and
   `/wallet/withdrawals`.
2. Bank-account creation omits required `gateway` and `bankName` fields and
   expects a `verified` boolean which the backend does not return.
3. Withdrawal creation sends `amountMinor` and `bankAccountId`; Backend V2
   expects `amountMinorUnits` and `idempotencyKey` in the request body. The
   backend pays the default verified account rather than accepting the selected
   account ID in this request.
4. Flutter polls a nonexistent single-withdrawal endpoint. Backend V2 currently
   provides only the paginated withdrawal list read.
5. The create response is wrapped in `withdrawalRequest`, but the Flutter model
   only unwraps `withdrawal`.
6. `FAILED` means the money is still reserved and the request can be retried or
   released by an admin. Flutter maps it to `reversed`, shows that funds were
   returned, treats it as terminal, and clears recovery. Only `RELEASED` may be
   shown as refunded/reversed.
7. `APPROVED` means reviewed but payout has not begun. Flutter maps it to
   processing and displays provider-processing language.
8. The production quote call intentionally returns null because Backend V2 has
   no quote/fee/limits endpoint. Consequently the real flow stops at an
   unavailable state; the complete screens seen in tests are fixture-driven.
9. The review/status designs include fee, net amount, balance, limits, and bank
   details not supplied by the withdrawal response. Those values must come from
   authoritative reads or be hidden/unavailable.

## Screen-by-screen result

| Screen | Result | Gap |
|---|---|---|
| 53 Withdraw money | Blocked | Quote is always null in production; fee, net and limits have no V2 source. |
| 54 Select bank account | Critical | Bank list route/envelope are wrong; selecting a non-default account does not change the backend payout destination. |
| 55 Add bank account | Critical | Required gateway and bank name are not sent; returned `bankAccount` envelope is not parsed. |
| 56 Verifying bank account | Blocked | Calls the wrong route and waits for a response field the backend never returns. |
| 57 Withdrawal review | Critical | Can display a selected destination different from the backend default; fee/net are unavailable. |
| 58 Verification required | Mostly aligned | Backend 403 eligibility errors support this state, subject to the correct request route. |
| 59 Pending review | Visual match, data path broken | Correct concept, but create-response parsing and status refresh fail. |
| 60 Processing | Semantics incomplete | `APPROVED` and `PROCESSING` must not use identical provider-processing copy. |
| 61 Successful | Visual match, unreachable | `COMPLETED` maps correctly, but the status endpoint is nonexistent. |
| 62 Reversed | Critical safety defect | `FAILED` is falsely shown as refunded and recovery is cleared. Only `RELEASED` is a refund. |
| 63 Limit reached | Unsupported | There is no withdrawal quote/limit read contract to authorize this state. |
| 134 Saved bank accounts | Broken integration | Wrong route and response-envelope parsing. |

## Required alignment

- Use paths relative to the existing `/api/v1` Dio base:
  `/wallet/bank-accounts`, `/wallet/withdrawal-request`, and
  `/wallet/withdrawals`.
- Send the documented request bodies and parse `bankAccounts`, `bankAccount`,
  `withdrawalRequest`, and `withdrawals` envelopes.
- Add explicit UI/domain states for `APPROVED` and `FAILED`; keep `FAILED`
  nonterminal and retain its recovery reference.
- Either set the selected bank as default via
  `PATCH /wallet/bank-accounts/:id/default` before submission or extend the
  backend contract to accept a bank-account ID. Never show an unconfirmed payout
  destination.
- Refresh status safely through the list contract until a single-withdrawal read
  is added.
- Decide whether the backend will add an authoritative quote/limits contract or
  whether the UI will omit fee/net/limit values. Flutter must not invent them.
- Change the contract configuration only when the matching Backend V2 endpoints
  are deployed; the checked-in example currently defaults to `legacy`.

## Verification performed

- Freshly rendered all 12 PR7 visual states in an isolated copy.
- `flutter test test/withdrawal_flow_visual_test.dart --update-goldens`:
  12 tests passed.
- Compared the status captures with the approved withdrawal-status board.
- Compared Flutter routes, request/response parsing, and status mapping against
  the PR7 backend handoff and current backend controller/service.

The passing visual tests prove rendering only; their fixture contracts currently
encode routes and response shapes that differ from the backend.
