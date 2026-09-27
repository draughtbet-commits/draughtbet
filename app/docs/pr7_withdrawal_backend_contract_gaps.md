# PR7 withdrawal Backend V2 contract gaps

This document records capabilities that the Flutter withdrawal UI cannot
safely infer. Flutter remains blocked or omits the affected values until the
backend supplies them authoritatively.

| Missing capability | Current backend behaviour | Flutter safe fallback | Required future contract | Screens |
|---|---|---|---|---|
| Withdrawal quote | No quote endpoint exists. `POST /wallet/withdrawal-request` immediately reserves funds. | Keep the amount entered on Screen 53, show temporary unavailability, allow retry or return to Wallet, and submit nothing. | A read/create-quote response containing canonical amount, currency, stable idempotency key, expiry, and eligibility. | 53, 57 |
| Fee and net payout | Withdrawal create/list responses contain the requested amount but no fee or net payout. | Do not calculate either value; omit them unless a future authoritative quote supplies them. | Quote/withdrawal fields for fee and net payout in minor units. | 53, 57, 59–62 |
| Withdrawal limits | No withdrawal-limit read or structured limit error is exposed. | Never calculate limits. Show Screen 63 only from an authoritative structured response; otherwise show generic unavailability/rejection. | Structured minimum, maximum, remaining limit and reason/code. | 53, 63 |
| Available balance and eligibility quote | Balance is available separately at `GET /wallet/balance`; withdrawal eligibility is enforced only during the money-moving request. | Do not combine a balance read with local eligibility rules or claim the amount is withdrawable. | A non-money-moving eligibility/quote read tied to the requested amount. | 53, 57, 58 |
| Payout-provider discovery | Bank creation requires `gateway`, but the backend exposes no supported-provider or bank-directory read. | Disable Add Bank submission and do not hardcode Paystack or Flutterwave. Existing verified accounts remain readable. | Server-provided enabled payout gateways and their supported bank directory/codes. | 55, 56, 134 |
| Destination selection | Withdrawal creation uses the verified default account. The controller does not accept `bankAccountId`, but `PATCH /wallet/bank-accounts/:id/default` is available. | Change the default first and proceed only after the server confirms the same account as default. Confirm the returned withdrawal `bankAccountId` matches it. | Prefer an explicit accepted destination ID on withdrawal create, or retain and document the default-management contract. | 54, 57, 59–62 |
| Single-withdrawal recovery | No `GET /wallet/withdrawals/:id` route exists. The collection read returns sufficient status fields. | Read the documented paginated collection and match the stored server reference. Keep the last authoritative state if it cannot be found. | A current-user single-withdrawal read by opaque ID/reference, including destination summary. | 59–62 |
| Destination details in withdrawal responses | Create/list responses expose `bankAccountId` but no masked destination object. | Preserve a destination summary only when it was server-confirmed in the current session; show unavailable after cold recovery. | Include a masked, immutable payout-destination snapshot in withdrawal reads. | 57, 59–62 |

## Status rules enforced in Flutter

- `PENDING_REVIEW`, `APPROVED`, `PROCESSING`, `FAILED`, and unknown statuses are
  non-terminal and retain recovery.
- `APPROVED` is awaiting payout; it is not provider processing.
- `FAILED` means funds remain reserved; it is not a refund.
- Only `COMPLETED` and `RELEASED` are terminal.
- Only `RELEASED` is presented as reversed/funds returned.
- Unknown statuses use a neutral reconciliation state and never imply success
  or refund.

The collection status read is read-only. Flutter never calls admin payout,
release, retry, webhook, ledger, or reconciliation execution endpoints.
