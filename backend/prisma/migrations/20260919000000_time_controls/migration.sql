-- Authoritative per-turn deadline snapshot at funding time.
-- Legacy ACTIVE matches stay NULL and run with the default (60s).
ALTER TABLE "Match" ADD COLUMN     "timeControlSeconds" INTEGER;

-- Live setting the funding snapshot is taken from.
ALTER TABLE "PlatformSettings" ADD COLUMN     "timeControlSeconds" INTEGER NOT NULL DEFAULT 60;