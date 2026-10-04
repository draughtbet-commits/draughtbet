-- Production readiness for the KYC verification gateway.
--
-- Two gaps blocked a real provider:
--
-- 1. `providerReference` did not exist. The adapter created a provider handle,
--    used it once, and discarded it, so an asynchronous result -- which knows
--    nothing but that handle -- could not be matched back to its case. It is
--    persisted at start, before any result can arrive.
--
-- 2. KYC webhook deliveries had nowhere to be recorded. Payment webhooks log to
--    PaymentWebhookEvent, but a verification delivery carries identity payloads
--    rather than money movements and is audited on its own terms. The unique
--    dedupeKey is what makes a replayed delivery a no-op instead of a second
--    application of the same result.
--
-- Deliberately scoped to these two changes: the schema carries unrelated
-- pre-existing drift on RulesetVersion.id which must not be swept into a
-- production migration.

-- Persist the provider's handle for a verification attempt.
ALTER TABLE "VerificationCase" ADD COLUMN "providerReference" TEXT;

-- Match an incoming webhook to its case.
CREATE INDEX "VerificationCase_providerReference_idx" ON "VerificationCase"("providerReference");

-- CreateTable
CREATE TABLE "VerificationWebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "providerReference" TEXT,
    "eventType" TEXT,
    "signatureValid" BOOLEAN NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "processingStatus" "WebhookProcessingStatus" NOT NULL DEFAULT 'RECEIVED',
    "errorCode" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "VerificationWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- A replayed delivery collides here and is recorded as a duplicate.
CREATE UNIQUE INDEX "VerificationWebhookEvent_dedupeKey_key" ON "VerificationWebhookEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "VerificationWebhookEvent_provider_providerReference_idx" ON "VerificationWebhookEvent"("provider", "providerReference");

-- CreateIndex
CREATE INDEX "VerificationWebhookEvent_processingStatus_receivedAt_idx" ON "VerificationWebhookEvent"("processingStatus", "receivedAt");