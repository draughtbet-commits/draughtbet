-- PR 3 read-flip: WalletTransaction table + Wallet.balanceMinorUnits + the
-- TxType/TxStatus enums are dropped now that reads and writes both live on the
-- V2 ledger. Guarded so a re-run is a no-op (Postgres DDL is not transactional
-- across statements).
DROP TABLE IF EXISTS "WalletTransaction";
ALTER TABLE "Wallet" DROP COLUMN IF EXISTS "balanceMinorUnits";
DROP TYPE IF EXISTS "TxType";
DROP TYPE IF EXISTS "TxStatus";