-- Add ESCALATED value to RiskCaseStatus enum
ALTER TYPE "RiskCaseStatus" ADD VALUE IF NOT EXISTS 'ESCALATED';

-- Create SupportCase enums
DO $$ BEGIN
  CREATE TYPE "SupportCaseStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING_ON_PLAYER', 'ESCALATED', 'RESOLVED', 'CLOSED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "SupportCasePriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "SupportCaseCategory" AS ENUM ('ACCOUNT', 'MATCH_DISPUTE', 'DEPOSIT', 'WITHDRAWAL', 'KYC_COMPLIANCE', 'TECHNICAL', 'OTHER');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Create SupportCase table
CREATE TABLE IF NOT EXISTS "SupportCase" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" "SupportCaseCategory" NOT NULL DEFAULT 'ACCOUNT',
    "priority" "SupportCasePriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "SupportCaseStatus" NOT NULL DEFAULT 'OPEN',
    "assignedTo" TEXT,
    "relatedMatchId" TEXT,
    "relatedTransactionRef" TEXT,
    "resolutionNote" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportCase_pkey" PRIMARY KEY ("id")
);

-- Create SupportCaseNote table
CREATE TABLE IF NOT EXISTS "SupportCaseNote" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorEmail" TEXT,
    "eventType" TEXT NOT NULL DEFAULT 'NOTE',
    "body" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportCaseNote_pkey" PRIMARY KEY ("id")
);

-- Create indexes and foreign keys
CREATE UNIQUE INDEX IF NOT EXISTS "SupportCase_reference_key" ON "SupportCase"("reference");
CREATE INDEX IF NOT EXISTS "SupportCase_userId_status_idx" ON "SupportCase"("userId", "status");
CREATE INDEX IF NOT EXISTS "SupportCase_status_priority_idx" ON "SupportCase"("status", "priority");
CREATE INDEX IF NOT EXISTS "SupportCase_assignedTo_idx" ON "SupportCase"("assignedTo");
CREATE INDEX IF NOT EXISTS "SupportCaseNote_caseId_createdAt_idx" ON "SupportCaseNote"("caseId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "SupportCase" ADD CONSTRAINT "SupportCase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "SupportCaseNote" ADD CONSTRAINT "SupportCaseNote_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "SupportCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

