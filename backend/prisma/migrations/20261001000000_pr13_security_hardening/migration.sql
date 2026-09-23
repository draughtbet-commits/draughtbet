/*
  Warnings:

  - Made the column `reference` on table `Withdrawal` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "Withdrawal" ALTER COLUMN "reference" SET NOT NULL;

-- CreateTable
CREATE TABLE "AdminMfa" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "enabledAt" TIMESTAMP(3) NOT NULL,
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminMfa_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminMfa_userId_key" ON "AdminMfa"("userId");

-- CreateIndex
CREATE INDEX "AdminMfa_enabledAt_idx" ON "AdminMfa"("enabledAt");

-- AddForeignKey
ALTER TABLE "AdminMfa" ADD CONSTRAINT "AdminMfa_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
