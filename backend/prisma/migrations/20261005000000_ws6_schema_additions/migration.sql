-- WS6 — contract data tables + additive LedgerEntryType contract members +
-- MatchReceipt.reference (server-generated, immutable, backfilled).
-- The existing-row TYPE remap runs as a SEPARATE migration
-- (`*_ws6_ledger_type_remap`) because Postgres forbids using a freshly
-- ADD VALUE'd enum member inside the same transaction that added it.
-- Additive only: no destructive changes, legacy enum members are retained.

-- 1. Contract ledger transaction types (decisions §10; additive)
ALTER TYPE "LedgerEntryType" ADD VALUE 'DEPOSIT_PENDING';
ALTER TYPE "LedgerEntryType" ADD VALUE 'DEPOSIT_CONFIRMED';
ALTER TYPE "LedgerEntryType" ADD VALUE 'DEPOSIT_FAILED';
ALTER TYPE "LedgerEntryType" ADD VALUE 'DEPOSIT_REVERSED';
ALTER TYPE "LedgerEntryType" ADD VALUE 'STAKE_RESERVED';
ALTER TYPE "LedgerEntryType" ADD VALUE 'STAKE_RELEASED';
ALTER TYPE "LedgerEntryType" ADD VALUE 'MATCH_SETTLED_WIN';
ALTER TYPE "LedgerEntryType" ADD VALUE 'MATCH_SETTLED_LOSS';
ALTER TYPE "LedgerEntryType" ADD VALUE 'MATCH_SETTLED_DRAW';
ALTER TYPE "LedgerEntryType" ADD VALUE 'WITHDRAWAL_PENDING';
ALTER TYPE "LedgerEntryType" ADD VALUE 'WITHDRAWAL_CONFIRMED';
ALTER TYPE "LedgerEntryType" ADD VALUE 'WITHDRAWAL_FAILED';
ALTER TYPE "LedgerEntryType" ADD VALUE 'WITHDRAWAL_REVERSED';
ALTER TYPE "LedgerEntryType" ADD VALUE 'WITHDRAWAL_RELEASED';
ALTER TYPE "LedgerEntryType" ADD VALUE 'ADJUSTMENT_CREDIT';
ALTER TYPE "LedgerEntryType" ADD VALUE 'ADJUSTMENT_DEBIT';

-- 2. MatchReceipt.reference — server-generated, immutable. Backfilled for
-- pre-existing rows using md5/random (always available) so the migration runs
-- on any PostgreSQL without needing gen_random_uuid().
ALTER TABLE "MatchReceipt" ADD COLUMN "reference" TEXT;
UPDATE "MatchReceipt" SET "reference" = 'rcpt-' || md5(random()::text || clock_timestamp()::text) WHERE "reference" IS NULL;
ALTER TABLE "MatchReceipt" ALTER COLUMN "reference" SET NOT NULL;
CREATE UNIQUE INDEX "MatchReceipt_reference_key" ON "MatchReceipt"("reference");

-- 3. New enums
CREATE TYPE "WebhookProcessingStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED_DUPLICATE', 'REJECTED', 'FAILED');
CREATE TYPE "SupportCaseType" AS ENUM ('GENERAL', 'PAYMENT', 'WITHDRAWAL', 'KYC', 'MATCH', 'ACCOUNT', 'SAFER_PLAY');
CREATE TYPE "SupportCaseStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING_USER', 'RESOLVED', 'CLOSED');
CREATE TYPE "ReconciliationIssueType" AS ENUM ('LEDGER_UNBALANCED', 'WALLET_PROJECTION_MISMATCH', 'MATCH_SETTLEMENT_MISMATCH', 'DEPOSIT_PROVIDER_MISMATCH', 'WITHDRAWAL_PROVIDER_MISMATCH', 'OTHER');

-- 4. KycDocument
CREATE TABLE "KycDocument" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "verificationCaseId" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "KycDocument_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "KycDocument_objectKey_key" ON "KycDocument"("objectKey");
CREATE INDEX "KycDocument_verificationCaseId_documentType_idx" ON "KycDocument"("verificationCaseId", "documentType");
ALTER TABLE "KycDocument" ADD CONSTRAINT "KycDocument_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "KycDocument" ADD CONSTRAINT "KycDocument_verificationCaseId_fkey" FOREIGN KEY ("verificationCaseId") REFERENCES "VerificationCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5. SaferPlayDailyUsage
CREATE TABLE "SaferPlayDailyUsage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "usageDate" DATE NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'NGN',
    "depositCommittedMinorUnits" BIGINT NOT NULL DEFAULT 0,
    "stakeCommittedMinorUnits" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaferPlayDailyUsage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SaferPlayDailyUsage_userId_usageDate_currency_key" ON "SaferPlayDailyUsage"("userId", "usageDate", "currency");
CREATE INDEX "SaferPlayDailyUsage_usageDate_idx" ON "SaferPlayDailyUsage"("usageDate");
ALTER TABLE "SaferPlayDailyUsage" ADD CONSTRAINT "SaferPlayDailyUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 6. PaymentWebhookEvent
CREATE TABLE "PaymentWebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" "Gateway" NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "providerEventId" TEXT,
    "providerReference" TEXT,
    "eventType" TEXT,
    "signatureValid" BOOLEAN NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "processingStatus" "WebhookProcessingStatus" NOT NULL DEFAULT 'RECEIVED',
    "metadata" JSONB,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "errorCode" TEXT,

    CONSTRAINT "PaymentWebhookEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PaymentWebhookEvent_dedupeKey_key" ON "PaymentWebhookEvent"("dedupeKey");
CREATE INDEX "PaymentWebhookEvent_provider_providerReference_idx" ON "PaymentWebhookEvent"("provider", "providerReference");
CREATE INDEX "PaymentWebhookEvent_processingStatus_receivedAt_idx" ON "PaymentWebhookEvent"("processingStatus", "receivedAt");

-- 7. RulesetVersion (frozen rules catalog, match-linked)
CREATE TABLE "RulesetVersion" (
    "id" TEXT NOT NULL,
    "displayName" VARCHAR(120) NOT NULL,
    "engineVersion" VARCHAR(64) NOT NULL,
    "config" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "RulesetVersion_pkey" PRIMARY KEY ("id")
);

-- 8. PlatformConfigVersion (config snapshots: fees/stake-limits/time-controls/etc.)
CREATE TABLE "PlatformConfigVersion" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "values" JSONB NOT NULL,
    "checksum" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "activeFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activeTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformConfigVersion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PlatformConfigVersion_version_key" ON "PlatformConfigVersion"("version");
CREATE INDEX "PlatformConfigVersion_activeFrom_activeTo_idx" ON "PlatformConfigVersion"("activeFrom", "activeTo");

-- 9. DevicePushToken
CREATE TABLE "DevicePushToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "tokenCiphertext" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "DevicePushToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DevicePushToken_tokenHash_key" ON "DevicePushToken"("tokenHash");
CREATE INDEX "DevicePushToken_userId_active_idx" ON "DevicePushToken"("userId", "active");
ALTER TABLE "DevicePushToken" ADD CONSTRAINT "DevicePushToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DevicePushToken" ADD CONSTRAINT "DevicePushToken_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "DeviceFingerprint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 10. PlayerStats
CREATE TABLE "PlayerStats" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL DEFAULT 1200,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "draws" INTEGER NOT NULL DEFAULT 0,
    "totalMatches" INTEGER NOT NULL DEFAULT 0,
    "currentStreak" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlayerStats_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PlayerStats_userId_key" ON "PlayerStats"("userId");
CREATE INDEX "PlayerStats_rating_idx" ON "PlayerStats"("rating");
ALTER TABLE "PlayerStats" ADD CONSTRAINT "PlayerStats_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 11. RatingEvent
CREATE TABLE "RatingEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "ratingBefore" INTEGER NOT NULL,
    "ratingAfter" INTEGER NOT NULL,
    "delta" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RatingEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RatingEvent_userId_matchId_key" ON "RatingEvent"("userId", "matchId");
CREATE INDEX "RatingEvent_matchId_idx" ON "RatingEvent"("matchId");
ALTER TABLE "RatingEvent" ADD CONSTRAINT "RatingEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RatingEvent" ADD CONSTRAINT "RatingEvent_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 12. SupportCase + SupportCaseEvent
CREATE TABLE "SupportCase" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "relatedMatchId" TEXT,
    "type" "SupportCaseType" NOT NULL,
    "status" "SupportCaseStatus" NOT NULL DEFAULT 'OPEN',
    "subject" TEXT NOT NULL,
    "description" TEXT,
    "assignedAdminUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "SupportCase_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SupportCase_userId_status_createdAt_idx" ON "SupportCase"("userId", "status", "createdAt");
CREATE INDEX "SupportCase_relatedMatchId_idx" ON "SupportCase"("relatedMatchId");
ALTER TABLE "SupportCase" ADD CONSTRAINT "SupportCase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupportCase" ADD CONSTRAINT "SupportCase_relatedMatchId_fkey" FOREIGN KEY ("relatedMatchId") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "SupportCaseEvent" (
    "id" TEXT NOT NULL,
    "supportCaseId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "eventType" TEXT NOT NULL,
    "message" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportCaseEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SupportCaseEvent_supportCaseId_createdAt_idx" ON "SupportCaseEvent"("supportCaseId", "createdAt");
ALTER TABLE "SupportCaseEvent" ADD CONSTRAINT "SupportCaseEvent_supportCaseId_fkey" FOREIGN KEY ("supportCaseId") REFERENCES "SupportCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 13. ReconciliationIssue (structured rows beside FinancialReconciliationRun.discrepancies)
CREATE TABLE "ReconciliationIssue" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "type" "ReconciliationIssueType" NOT NULL,
    "severity" "RiskSeverity" NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "expected" TEXT,
    "actual" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,

    CONSTRAINT "ReconciliationIssue_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ReconciliationIssue_runId_type_idx" ON "ReconciliationIssue"("runId", "type");
CREATE INDEX "ReconciliationIssue_resolvedAt_severity_idx" ON "ReconciliationIssue"("resolvedAt", "severity");
ALTER TABLE "ReconciliationIssue" ADD CONSTRAINT "ReconciliationIssue_runId_fkey" FOREIGN KEY ("runId") REFERENCES "FinancialReconciliationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 14. Match -> versioned config (additive nullable FKs; Int snapshot columns stay authoritative)
ALTER TABLE "Match" ADD COLUMN "rulesetDefId" TEXT;
ALTER TABLE "Match" ADD COLUMN "configVersionId" TEXT;
ALTER TABLE "Match" ADD CONSTRAINT "Match_rulesetDefId_fkey" FOREIGN KEY ("rulesetDefId") REFERENCES "RulesetVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Match" ADD CONSTRAINT "Match_configVersionId_fkey" FOREIGN KEY ("configVersionId") REFERENCES "PlatformConfigVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 15. DisputeCase <=> SupportCase (additive nullable link)
ALTER TABLE "DisputeCase" ADD COLUMN "supportCaseId" TEXT;
CREATE UNIQUE INDEX "DisputeCase_supportCaseId_key" ON "DisputeCase"("supportCaseId");
ALTER TABLE "DisputeCase" ADD CONSTRAINT "DisputeCase_supportCaseId_fkey" FOREIGN KEY ("supportCaseId") REFERENCES "SupportCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;