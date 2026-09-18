# Backend handoff: Durable outbox, payout follow-up & financial reconciliation (PR 12)

Date: 2026-09-18
Branch: `refactor/backend-v2` (local only, not pushed)
Audience: frontend / Flutter client and Citycod review

## Summary

This PR makes the backend **crash-safe for money and game events**. The rule is
simple: *a writer never emits a socket push from outside the transaction that
changed the state it announces.* Instead it enqueues a durable `OutboxEvent`
row in the **same transaction**, and a drainer job delivers it a moment later
(at-least-once). If the app dies mid-delivery, the row is still `PENDING` and is
reclaimed on the next cycle — nothing committed is ever lost, and nothing is
ever delivered twice. Two reconciliation sweeps are added so drift from bugs or
crashes is caught (read-only) rather than papered over, plus a payout
follow-up that resolves withdrawals stuck at the payment provider.

Client-visible behaviour is unchanged; the socket events clients already
consume (`wallet_updated`, `notification`) now arrive via the durable pipeline.

## What changed (client-visible surface)

- `wallet_updated` and `notification` socket events now come from the outbox
  drainer (~1s SECRETS) instead of a direct inline emit. Payload shapes are
  identical, and replay-safe: a duplicate delivery is a harmless refresh that
  sets the same balance/notification. **Nothing for the app to change.**
- `match.state` / `move.accepted` clock + grace fields and the rest of the
  game protocol are untouched by this PR.
- New/unchanged HTTP and socket routes — no endpoint signatures changed.

## Durability model (what engineers upstream care about)

- **Writers** (deposit webhook, withdrawal reserve/complete/release, match
  settlement, notification creation) create the outbox row with a
  `dedupeKey @unique` **inside** the same `prisma.$transaction` as the ledger
  posting / status change. A crash before commit → row never exists → the
  business action is simply not complete; a crash after commit → row is
  `PENDING` → drainer delivers it later.
- **Drainer** (`jobs/outboxDrainer.js`, every 1s): claims batch of lease-free
  `PENDING` rows (unique token + 30s lease) → delivers socket push → CAS-settle
  `SENT`. Delivery failure: `attempts++` and clear the lease (retried next
  cycle); after 5 attempts the row is parked `FAILED` with `lastError` for
  operator review. A crashed claim is reclaimed after the lease expires.
- **Reconciliation sweeps** (read-only, run from `app.js`, disabled under
  tests):
  - `jobs/financialReconciliation.js` (every 5m): verifies every ledger
    transaction is double-entry and zero-sum, that money is conserved across the
    player/system divide (closed book), that `CUSTOMER_LIABILITY` is a single
    singleton, and that withdrawal/deposit/settlement postings match their
    domain rows. It **never repairs** — discrepancies are recorded on a
    `FinancialReconciliationRun` (status `FAILED`) and logged for ops.
  - `jobs/providerFollowUp.js` (every 10m): withdrawals stuck in `PROCESSING`
    for >6h without a webhook are probed at the provider; a terminal verdict
    funnels through the same CAS as the webhook path, so resolving twice is a
    safe no-op. Success funds leave the platform exactly once; failure keeps
    funds reserved; ambiguous answers only record the re-check.

## What this means operationally

- A restart mid-push may cause a **duplicate** socket `wallet_updated`
  (at-least-once) — harmless by design. It will **never** drop a committed
  credit/settlement or double-book money. For **exactly-once** money effects,
  idempotency keys make duplicate ledger postings no-ops
  (`withdrawal:reserve:{id}`, `withdrawal:complete:{id}`,
  `deposit:credit:{reference}`, `MATCH_SETTLEMENT:{matchId}`).
- `OutboxEvent` rows are only ever `PENDING/SENT/FAILED`; parked `FAILED` rows
  need operator review (why an event cannot be delivered — normally a bad
  eventType, a product bug).
- `FinancialReconciliationRun` rows with `FAILED` are the ops signal: check the
  listed discrepancy, fix the underlying cause. The sweep is watch-only by
  design to avoid auto-repairing the book.

## Deep verification

`backend/scripts/verify/pr12-outbox-reconciliation.mjs` drives the real
modules against PostgreSQL + Redis and asserts 11 checks that map directly to
this PR's exit gate: outbox claim→deliver→SENT once (O1), dedupeKey replay
enqueues nothing (O2), live lease skipped / expired lease reclaimed (O3),
transient delivery failure backs off then delivers (O4), persistent failure
parks `FAILED` (O5), unknown eventType parks `FAILED` (O6); payout follow-up
resolves a stale `PROCESSING` payout to COMPLETED exactly once with the
`withdrawal:complete` posting + durable notification (W1), failure keeps funds
reserved (W2), ambiguous verdict re-probes later (W3); healthy book closes with
zero discrepancies (R1); a tampered posting is flagged and never repaired (R2).
**11/11 PASS**, and it ends by re-opening the whole ledger to confirm zero-sum +
single liability singleton + a silent sweep **after** cleaning up its own rows.
(The outbox probes count per-drain events, so it must run on a freshly wiped
DB — the exit gate does exactly this.)

Full battery on a wiped dev DB: **53 unit suites / 460 tests** green + **14
integration suites / 83 tests** green + pr12 harness 11/11. DB and Redis were
wiped again after the battery, so the repo is left pristine.