-- Rebalance the per-tier stake bounds into a continuous range (min → max) and
-- open call-outs to every tier. Every tier now shares a ₦500 floor; the ceiling
-- rises with tier. This is applied in two places: the column defaults (for
-- freshly provisioned databases) and the existing settings singleton (for a
-- database that already has one).
--
-- The active PlatformConfigVersion is closed so the boot seed in
-- configVersionsService.ensureActiveConfigVersions records a new immutable
-- snapshot of the changed settings on the next start.

-- AlterTable (column defaults)
ALTER TABLE "PlatformSettings" ALTER COLUMN "amateurStakeMaxP" SET DEFAULT 5000000;
ALTER TABLE "PlatformSettings" ALTER COLUMN "masterStakeMinP" SET DEFAULT 50000;
ALTER TABLE "PlatformSettings" ALTER COLUMN "masterStakeMaxP" SET DEFAULT 15000000;
ALTER TABLE "PlatformSettings" ALTER COLUMN "proStakeMinP" SET DEFAULT 50000;
ALTER TABLE "PlatformSettings" ALTER COLUMN "proStakeMaxP" SET DEFAULT 30000000;
ALTER TABLE "PlatformSettings" ALTER COLUMN "amateurCalloutMaxP" SET DEFAULT 5000000;
ALTER TABLE "PlatformSettings" ALTER COLUMN "masterCalloutMaxP" SET DEFAULT 15000000;
ALTER TABLE "PlatformSettings" ALTER COLUMN "proCalloutMaxP" SET DEFAULT 30000000;

-- Apply the new bounds to the seeded singleton, if present. ₦500 = 50000 kobo.
UPDATE "PlatformSettings"
SET
  "amateurStakeMinP"   = 50000,
  "amateurStakeMaxP"   = 5000000,
  "masterStakeMinP"    = 50000,
  "masterStakeMaxP"    = 15000000,
  "proStakeMinP"       = 50000,
  "proStakeMaxP"       = 30000000,
  "amateurCalloutMaxP" = 5000000,
  "masterCalloutMaxP"  = 15000000,
  "proCalloutMaxP"     = 30000000
WHERE "id" = 'singleton';

-- Close the active config version; the boot seed will append a new snapshot.
UPDATE "PlatformConfigVersion" SET "activeTo" = CURRENT_TIMESTAMP WHERE "activeTo" IS NULL;
