-- CreateEnum
CREATE TYPE "ConfigVersionStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'SUPERSEDED', 'REJECTED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "ConfigApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM ('TRANSACTIONAL', 'GAMEPLAY', 'ACCOUNT', 'COMPLIANCE', 'MARKETING_SYSTEM');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'PUSH', 'EMAIL');

-- CreateEnum
CREATE TYPE "MaintenanceScope" AS ENUM ('FULL_PLATFORM', 'GAMEPLAY_ONLY', 'MATCHMAKING_ONLY', 'FINANCIAL_ONLY');

-- CreateTable
CREATE TABLE "PlatformConfigVersion" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "ConfigVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "checksum" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "changeReason" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3),
    "isRestricted" BOOLEAN NOT NULL DEFAULT false,
    "authorId" TEXT NOT NULL,
    "activatedById" TEXT,
    "activatedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "rolledBackFrom" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformConfigVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfigApproval" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "status" "ConfigApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "reviewNote" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConfigApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeatureFlag" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "rolloutPercentage" INTEGER NOT NULL DEFAULT 0,
    "allowedTiers" "Tier"[] DEFAULT ARRAY[]::"Tier"[],
    "allowedRoles" "AdminRoleName"[] DEFAULT ARRAY[]::"AdminRoleName"[],
    "isKillSwitch" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeatureFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceState" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "active" BOOLEAN NOT NULL DEFAULT false,
    "scope" "MaintenanceScope" NOT NULL DEFAULT 'FULL_PLATFORM',
    "headline" TEXT NOT NULL DEFAULT 'Platform Under Scheduled Maintenance',
    "message" TEXT NOT NULL DEFAULT 'We are performing essential system updates. Gameplay and financial operations will resume shortly.',
    "allowedIps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowedRoles" "AdminRoleName"[] DEFAULT ARRAY['SUPER_ADMIN']::"AdminRoleName"[],
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaintenanceState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationTemplate" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "bodyTemplate" TEXT NOT NULL,
    "category" "NotificationCategory" NOT NULL DEFAULT 'TRANSACTIONAL',
    "channels" "NotificationChannel"[] DEFAULT ARRAY['IN_APP']::"NotificationChannel"[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "variables" TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlatformConfigVersion_version_key" ON "PlatformConfigVersion"("version");

-- CreateIndex
CREATE INDEX "PlatformConfigVersion_status_idx" ON "PlatformConfigVersion"("status");

-- CreateIndex
CREATE INDEX "PlatformConfigVersion_version_idx" ON "PlatformConfigVersion"("version");

-- CreateIndex
CREATE INDEX "ConfigApproval_status_idx" ON "ConfigApproval"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ConfigApproval_versionId_reviewerId_key" ON "ConfigApproval"("versionId", "reviewerId");

-- CreateIndex
CREATE UNIQUE INDEX "FeatureFlag_key_key" ON "FeatureFlag"("key");

-- CreateIndex
CREATE INDEX "FeatureFlag_key_enabled_idx" ON "FeatureFlag"("key", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationTemplate_code_key" ON "NotificationTemplate"("code");

-- CreateIndex
CREATE INDEX "NotificationTemplate_code_isActive_idx" ON "NotificationTemplate"("code", "isActive");

-- AddForeignKey
ALTER TABLE "PlatformConfigVersion" ADD CONSTRAINT "PlatformConfigVersion_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformConfigVersion" ADD CONSTRAINT "PlatformConfigVersion_activatedById_fkey" FOREIGN KEY ("activatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfigApproval" ADD CONSTRAINT "ConfigApproval_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "PlatformConfigVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfigApproval" ADD CONSTRAINT "ConfigApproval_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeatureFlag" ADD CONSTRAINT "FeatureFlag_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceState" ADD CONSTRAINT "MaintenanceState_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationTemplate" ADD CONSTRAINT "NotificationTemplate_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
