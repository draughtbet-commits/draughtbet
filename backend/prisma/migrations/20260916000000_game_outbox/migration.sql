-- AlterTable
ALTER TYPE "MatchStatus" ADD VALUE 'RELEASED';

-- CreateEnum
CREATE TYPE "GameOutboxStatus" AS ENUM ('PENDING', 'ACTIVATING', 'ACTIVATED', 'RELEASED');

-- CreateTable
CREATE TABLE "GameOutbox" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "player1Id" TEXT NOT NULL,
    "player2Id" TEXT NOT NULL,
    "tier" "Tier" NOT NULL,
    "stakeMinorUnits" BIGINT NOT NULL,
    "status" "GameOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "claimToken" TEXT,
    "claimExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GameOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GameOutbox_matchId_key" ON "GameOutbox"("matchId");

-- CreateIndex
CREATE UNIQUE INDEX "GameOutbox_claimToken_key" ON "GameOutbox"("claimToken");

-- CreateIndex
CREATE INDEX "GameOutbox_status_updatedAt_idx" ON "GameOutbox"("status", "updatedAt");

-- AddForeignKey
ALTER TABLE "GameOutbox" ADD CONSTRAINT "GameOutbox_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;