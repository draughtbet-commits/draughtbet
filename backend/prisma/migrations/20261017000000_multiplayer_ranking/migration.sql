-- Official multiplayer ranking (Elo). Adds the configuration-driven rating
-- service defaults, a per-match rated/unrated flag, and the audit fields on
-- RatingEvent (rank snapshots, result, reason, rated flag). This is additive:
-- no existing ledger, settlement or receipt behaviour changes.

-- ---------------------------------------------------------------------------
-- Rating enums
-- ---------------------------------------------------------------------------
CREATE TYPE "RatingResult" AS ENUM ('WIN', 'LOSS', 'DRAW', 'REVERSAL');
CREATE TYPE "RatingReason" AS ENUM ('NORMAL', 'TIMEOUT', 'RESIGNATION', 'DISCONNECT', 'ADMIN_REVERSAL');

-- ---------------------------------------------------------------------------
-- PlatformSettings — configurable rating defaults (admin-editable + versioned)
-- ---------------------------------------------------------------------------
ALTER TABLE "PlatformSettings" ADD COLUMN "startingRating"        INTEGER NOT NULL DEFAULT 1200;
ALTER TABLE "PlatformSettings" ADD COLUMN "provisionalMatchCount" INTEGER NOT NULL DEFAULT 20;
ALTER TABLE "PlatformSettings" ADD COLUMN "provisionalKFactor"    INTEGER NOT NULL DEFAULT 40;
ALTER TABLE "PlatformSettings" ADD COLUMN "establishedKFactor"    INTEGER NOT NULL DEFAULT 24;
ALTER TABLE "PlatformSettings" ADD COLUMN "masterRankMinRating"   INTEGER NOT NULL DEFAULT 1400;
ALTER TABLE "PlatformSettings" ADD COLUMN "proRankMinRating"      INTEGER NOT NULL DEFAULT 1800;

-- ---------------------------------------------------------------------------
-- Match — rated/unrated flag
-- ---------------------------------------------------------------------------
ALTER TABLE "Match" ADD COLUMN "rated" BOOLEAN NOT NULL DEFAULT true;

-- ---------------------------------------------------------------------------
-- RatingEvent — rank snapshots, result, reason, rated flag
-- ---------------------------------------------------------------------------
ALTER TABLE "RatingEvent" ADD COLUMN "previousRank" "Tier"        NOT NULL DEFAULT 'AMATEUR';
ALTER TABLE "RatingEvent" ADD COLUMN "newRank"      "Tier"        NOT NULL DEFAULT 'AMATEUR';
ALTER TABLE "RatingEvent" ADD COLUMN "result"       "RatingResult" NOT NULL DEFAULT 'DRAW';
ALTER TABLE "RatingEvent" ADD COLUMN "reason"       "RatingReason" NOT NULL DEFAULT 'NORMAL';
ALTER TABLE "RatingEvent" ADD COLUMN "rated"        BOOLEAN       NOT NULL DEFAULT true;

-- Backfill existing events: derive the result from the delta sign and the rank
-- snapshots from the launch bands (Master >= 1400, Pro >= 1800).
UPDATE "RatingEvent" SET "result" = CASE
  WHEN "delta" > 0 THEN 'WIN'::"RatingResult"
  WHEN "delta" < 0 THEN 'LOSS'::"RatingResult"
  ELSE 'DRAW'::"RatingResult"
END;
UPDATE "RatingEvent" SET "previousRank" = CASE
  WHEN "ratingBefore" >= 1800 THEN 'PRO'::"Tier"
  WHEN "ratingBefore" >= 1400 THEN 'MASTER'::"Tier"
  ELSE 'AMATEUR'::"Tier"
END;
UPDATE "RatingEvent" SET "newRank" = CASE
  WHEN "ratingAfter" >= 1800 THEN 'PRO'::"Tier"
  WHEN "ratingAfter" >= 1400 THEN 'MASTER'::"Tier"
  ELSE 'AMATEUR'::"Tier"
END;

-- Replace the single-per-pair uniqueness with one that still dedupes normal
-- events (a player can only ever have one WIN/LOSS/DRAW per match) but lets the
-- single compensating REVERSAL event coexist.
DROP INDEX "RatingEvent_userId_matchId_key";
CREATE UNIQUE INDEX "RatingEvent_userId_matchId_result_key" ON "RatingEvent"("userId", "matchId", "result");
CREATE INDEX "RatingEvent_userId_createdAt_idx" ON "RatingEvent"("userId", "createdAt");

-- Close the active config version; the boot seed appends a new snapshot.
UPDATE "PlatformConfigVersion" SET "activeTo" = CURRENT_TIMESTAMP WHERE "activeTo" IS NULL;
