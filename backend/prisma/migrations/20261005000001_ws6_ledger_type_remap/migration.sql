-- WS6 — remap existing ledger transactions to the contract event names
-- (decisions §10). Runs as a SOLO migration because Postgres forbids using an
-- enum member inside the same transaction that ADD VALUE'd it. Legacy enum
-- members are retained (additive); only row values are rewritten here.
-- Deprecated-member retention means no data is destroyed.

-- Deposit
UPDATE "LedgerTransaction" SET "type" = 'DEPOSIT_CONFIRMED' WHERE "type" = 'DEPOSIT_CREDIT';

-- Stakes
UPDATE "LedgerTransaction" SET "type" = 'STAKE_RESERVED' WHERE "type" = 'STAKE_LOCK';
UPDATE "LedgerTransaction" SET "type" = 'STAKE_RELEASED' WHERE "type" = 'STAKE_RELEASE';

-- Settlement: a decided match credits only the winner (WIN, winnerId in
-- metadata); a draw refunds both players (DRAW, no winnerId).
-- MATCH_SETTLED_LOSS is never posted — the loser leg has no entry on a user-
-- facing account, so there is no row to rewrite to it.
UPDATE "LedgerTransaction" SET "type" = 'MATCH_SETTLED_WIN'
  WHERE "type" = 'SETTLEMENT_PAYOUT'
    AND ("metadata"->>'winnerId') IS NOT NULL
    AND ("metadata"->>'winnerId') <> '';
UPDATE "LedgerTransaction" SET "type" = 'MATCH_SETTLED_DRAW'
  WHERE "type" = 'SETTLEMENT_PAYOUT'
    AND (("metadata"->>'winnerId') IS NULL OR ("metadata"->>'winnerId') = '');

-- Withdrawals
UPDATE "LedgerTransaction" SET "type" = 'WITHDRAWAL_PENDING' WHERE "type" = 'WITHDRAWAL_RESERVE';
UPDATE "LedgerTransaction" SET "type" = 'WITHDRAWAL_CONFIRMED' WHERE "type" = 'WITHDRAWAL_COMPLETE';
UPDATE "LedgerTransaction" SET "type" = 'WITHDRAWAL_RELEASED' WHERE "type" = 'WITHDRAWAL_RELEASE';

-- Adjustments: the adjustment posting records its direction in metadata.
UPDATE "LedgerTransaction" SET "type" = 'ADJUSTMENT_CREDIT'
  WHERE "type" = 'ADJUSTMENT' AND "metadata"->>'direction' = 'CREDIT';
UPDATE "LedgerTransaction" SET "type" = 'ADJUSTMENT_DEBIT'
  WHERE "type" = 'ADJUSTMENT' AND "metadata"->>'direction' = 'DEBIT';
-- Any ADJUSTMENT without a recorded direction (manual/edge inserts) defaults
-- to DEBIT, matching the conservation of the CUSTOMER_LIABILITY write down.
UPDATE "LedgerTransaction" SET "type" = 'ADJUSTMENT_DEBIT' WHERE "type" = 'ADJUSTMENT';