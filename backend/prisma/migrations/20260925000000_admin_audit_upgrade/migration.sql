-- Hardened admin audit trail + dispute decision attribution.
-- The RBAC layer writes and reads AdminAuditLog for every privileged action;
-- query indexes and an outcome enum answer "who did what, and did it succeed".
CREATE TYPE "AdminAuditOutcome" AS ENUM ('SUCCESS', 'FAILURE', 'DENIED');

ALTER TABLE "AdminAuditLog"
  ADD COLUMN "outcome"    "AdminAuditOutcome" NOT NULL DEFAULT 'SUCCESS',
  ADD COLUMN "targetType" TEXT,
  ADD COLUMN "ip"         TEXT,
  ADD COLUMN "userAgent"  TEXT,
  ADD COLUMN "requestId"  TEXT;

CREATE INDEX "AdminAuditLog_adminId_idx" ON "AdminAuditLog"("adminId");
CREATE INDEX "AdminAuditLog_createdAt_idx" ON "AdminAuditLog"("createdAt");

-- Who closed a dispute and when.
ALTER TABLE "DisputeCase"
  ADD COLUMN "decidedBy" TEXT,
  ADD COLUMN "decidedAt" TIMESTAMP(3);