-- AlterTable
ALTER TABLE "Match" ADD COLUMN     "settlementCommissionPercent" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "WalletTransaction_relatedMatchId_type_walletId_key" ON "WalletTransaction"("relatedMatchId", "type", "walletId");
