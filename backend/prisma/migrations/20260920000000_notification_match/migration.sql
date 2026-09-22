-- AlterTable
ALTER TABLE "Notification" ADD COLUMN "matchId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Notification_userId_matchId_type_key" ON "Notification"("userId", "matchId", "type");

-- CreateIndex
CREATE INDEX "Notification_matchId_idx" ON "Notification"("matchId");