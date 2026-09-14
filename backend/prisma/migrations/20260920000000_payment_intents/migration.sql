-- CreateTable
CREATE TABLE "DepositIntent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "gateway" "Gateway" NOT NULL,
    "reference" TEXT NOT NULL,
    "amountMinorUnits" BIGINT NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'NGN',
    "status" "DepositIntentStatus" NOT NULL DEFAULT 'PENDING',
    "authorizationUrl" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepositIntent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DepositIntent_reference_key" ON "DepositIntent"("reference");

-- CreateIndex
CREATE INDEX "DepositIntent_userId_status_idx" ON "DepositIntent"("userId", "status");

-- AddForeignKey
ALTER TABLE "DepositIntent" ADD CONSTRAINT "DepositIntent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositIntent" ADD CONSTRAINT "DepositIntent_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;