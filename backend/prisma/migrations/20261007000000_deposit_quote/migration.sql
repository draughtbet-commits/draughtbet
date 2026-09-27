-- Server-owned deposit quotes. A quote is the client's only source of truth for
-- deposit amount, fee, total, currency and the set of available gateways — the
-- client must never invent any of them. The quote is created before an intent
-- and re-validated when the intent is created, so what the user was shown and
-- what they are charged cannot drift apart.

-- CreateEnum
CREATE TYPE "DepositQuoteStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'EXPIRED');

-- CreateTable
CREATE TABLE "DepositQuote" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amountMinorUnits" BIGINT NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'NGN',
    "feeMinorUnits" BIGINT NOT NULL DEFAULT 0,
    "totalMinorUnits" BIGINT NOT NULL,
    "paymentMethods" JSONB NOT NULL,
    "status" "DepositQuoteStatus" NOT NULL DEFAULT 'ACTIVE',
    "idempotencyKey" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedByIntentId" TEXT,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepositQuote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DepositQuote_userId_status_idx" ON "DepositQuote"("userId", "status");

-- CreateIndex
CREATE INDEX "DepositQuote_status_expiresAt_idx" ON "DepositQuote"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "DepositQuote_consumedByIntentId_key" ON "DepositQuote"("consumedByIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "DepositQuote_userId_idempotencyKey_key" ON "DepositQuote"("userId", "idempotencyKey");

-- AlterTable
ALTER TABLE "DepositQuote" ADD CONSTRAINT "DepositQuote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Deposit quote policy lives on the settings singleton so the fee schedule and
-- the enabled gateway set are server-owned. Defaults are zero-fee placeholders
-- pending client-confirmed Nigeria-market pricing.
-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN "paystackEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN "flutterwaveEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN "paystackFeeBps" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN "flutterwaveFeeBps" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN "depositMinP" BIGINT NOT NULL DEFAULT 10000;

-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN "depositMaxP" BIGINT NOT NULL DEFAULT 50000000;

-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN "depositQuoteTtlSeconds" INTEGER NOT NULL DEFAULT 900;
