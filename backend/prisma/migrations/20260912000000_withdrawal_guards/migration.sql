-- AlterTable
ALTER TABLE "WithdrawalRequest" ADD COLUMN     "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "WithdrawalRequest_userId_idempotencyKey_key" ON "WithdrawalRequest"("userId", "idempotencyKey");

-- S01: DB-level money invariants. Prisma does not model CHECK constraints in
-- schema.prisma, so these live here in the migration and are not tracked by
-- schema drift (Prisma's migration engine ignores constraints it didn't create
-- and existing rows already satisfy them at migration time).
ALTER TABLE "Wallet" ADD CONSTRAINT "chk_wallet_balance_nonnegative" CHECK ("balanceMinorUnits" >= 0);
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "chk_wallet_transaction_amount_nonzero" CHECK ("amountMinorUnits" <> 0);
ALTER TABLE "WithdrawalRequest" ADD CONSTRAINT "chk_withdrawal_amount_positive" CHECK ("amountMinorUnits" > 0);
