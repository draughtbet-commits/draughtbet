-- Safer-play limit changes: a RAISE is staged and only becomes effective after
-- the cooling window (PlatformSettings.limitRaiseCoolingHours); lowering or a
-- first-time limit applies immediately. Timeout/self-exclusion are extend-only.
ALTER TABLE "SaferPlayProfile"
  ADD COLUMN "pendingDepositLimitMinorUnits" BIGINT,
  ADD COLUMN "pendingDepositLimitRaisedAt" TIMESTAMP(3),
  ADD COLUMN "pendingStakeLimitMinorUnits" BIGINT,
  ADD COLUMN "pendingStakeLimitRaisedAt" TIMESTAMP(3);

-- Admin-editable cooling window; default 24h.
ALTER TABLE "PlatformSettings" ADD COLUMN "limitRaiseCoolingHours" INTEGER NOT NULL DEFAULT 24;