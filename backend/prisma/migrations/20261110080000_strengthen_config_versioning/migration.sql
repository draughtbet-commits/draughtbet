-- AlterTable
ALTER TABLE "ConfigApproval" ADD COLUMN IF NOT EXISTS "checksum" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "PlatformConfigVersion" ADD COLUMN IF NOT EXISTS "modifiedDomains" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Create Sequence for atomic concurrency-safe configuration version allocation
CREATE SEQUENCE IF NOT EXISTS platform_config_version_seq;
SELECT setval('platform_config_version_seq', COALESCE((SELECT MAX(version) FROM "PlatformConfigVersion"), 0) + 1, false);

-- Create Partial Unique Index guaranteeing strictly at most ONE row with status = 'ACTIVE'
CREATE UNIQUE INDEX IF NOT EXISTS "platform_config_single_active_idx" 
ON "PlatformConfigVersion" ("status") 
WHERE "status" = 'ACTIVE';

