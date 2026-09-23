-- Durable outbox delivery + provider payout follow-up.
--
-- OutboxEvent gains an exclusive claim/lease so the drainer is restart-safe: a
-- PENDING row is claimed with a token + expiry, and only the claimer marks it
-- SENT/FAILED. A crash mid-delivery leaves the lease to expire so the next
-- drain cycle reclaims it (at-least-once). The optional dedupeKey makes a
-- replay/recovery path a no-op instead of stacking a second event.
ALTER TABLE "OutboxEvent"
  ADD COLUMN "claimToken" TEXT,
  ADD COLUMN "claimExpiresAt" TIMESTAMP(3),
  ADD COLUMN "dedupeKey" TEXT;

CREATE UNIQUE INDEX "OutboxEvent_claimToken_key" ON "OutboxEvent"("claimToken");
CREATE UNIQUE INDEX "OutboxEvent_dedupeKey_key" ON "OutboxEvent"("dedupeKey");

-- Marks when the payout follow-up sweep last checked a PROCESSING withdrawal,
-- so each run only probes rows that are actually due for a re-check.
ALTER TABLE "Withdrawal"
  ADD COLUMN "followUpCheckAt" TIMESTAMP(3);