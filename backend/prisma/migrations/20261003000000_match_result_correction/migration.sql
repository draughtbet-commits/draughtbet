-- AlterTable: accept a client-supplied dispute category (e.g. TECHNICAL_RESULT).
ALTER TABLE "DisputeCase" ADD COLUMN "category" TEXT;

-- CreateTable: append-only dispute result correction record.
-- Original match/settlement/receipt rows are never rewritten; money changes
-- flow through a separate balanced ledger adjustment referencing the dispute.
CREATE TABLE "MatchResultCorrection" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "disputeCaseId" TEXT NOT NULL,
    "priorWinnerId" TEXT,
    "correctedWinnerId" TEXT,
    "priorEndReason" TEXT,
    "correctedEndReason" TEXT,
    "reason" TEXT NOT NULL,
    "decidedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchResultCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MatchResultCorrection_matchId_idx" ON "MatchResultCorrection"("matchId");

-- CreateIndex
CREATE INDEX "MatchResultCorrection_disputeCaseId_idx" ON "MatchResultCorrection"("disputeCaseId");

-- AddForeignKey
ALTER TABLE "MatchResultCorrection" ADD CONSTRAINT "MatchResultCorrection_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchResultCorrection" ADD CONSTRAINT "MatchResultCorrection_disputeCaseId_fkey" FOREIGN KEY ("disputeCaseId") REFERENCES "DisputeCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;