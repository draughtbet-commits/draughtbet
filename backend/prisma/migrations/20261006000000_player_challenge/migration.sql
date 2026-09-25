-- Directed player challenges. A challenge is a single immutable claim on a
-- Match's join: the invitee may accept (join) while PENDING; if they decline
-- (or the inviter cancels, or the match expires) the row is terminal. The
-- match row itself already carries OPEN status and the creator = LIGHT side.

-- CreateEnum
CREATE TYPE "MatchChallengeStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED');

-- CreateTable
CREATE TABLE "MatchChallenge" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "inviterId" TEXT NOT NULL,
    "inviteeId" TEXT NOT NULL,
    "stakeMinorUnits" BIGINT NOT NULL DEFAULT 0,
    "status" "MatchChallengeStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatchChallenge_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "MatchChallenge" ADD CONSTRAINT "MatchChallenge_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "MatchChallenge_matchId_idx" ON "MatchChallenge"("matchId");

-- CreateIndex
CREATE INDEX "MatchChallenge_inviteeId_status_idx" ON "MatchChallenge"("inviteeId", "status");

-- CreateIndex
CREATE INDEX "MatchChallenge_inviterId_inviteeId_status_idx" ON "MatchChallenge"("inviterId", "inviteeId", "status");