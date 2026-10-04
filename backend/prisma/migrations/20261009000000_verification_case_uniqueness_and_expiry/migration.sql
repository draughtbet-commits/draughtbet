-- Hardening follow-up to the verification gateway rollout.
--
-- The first attempt made providerReference indexed only, and the webhook path
-- looked the case up with findUnique on it. Prisma rejects findUnique on a
-- non-unique field at runtime, so every Dojah delivery threw before touching
-- the database -- which the unit tests could not see, because they mock Prisma
-- out entirely.
--
-- Uniqueness is the real invariant we want anyway: one provider reference means
-- exactly one verification attempt, so a webhook resolving to two cases could
-- settle an unrelated player. Postgres allows repeated NULLs in a unique index,
-- so synchronous attempts that never needed a handle are unaffected.
--
-- Duplicate values are resolved to NULL rather than failing the migration: two
-- cases sharing a reference is the exact corruption the constraint exists to
-- prevent, and there is no safe way to pick a winner. No duplicate exists yet
-- (the column was added in the previous migration and nothing has written one),
-- so this is a guard rather than a repair.

-- Drop duplicates first: CREATE UNIQUE INDEX would otherwise abort the whole
-- migration. The older row is cleared and the newer one keeps the reference,
-- so a case that a webhook still has to resolve stays resolvable.
UPDATE "VerificationCase" AS older
   SET "providerReference" = NULL
  FROM "VerificationCase" AS newer
 WHERE older."providerReference" IS NOT NULL
   AND older."providerReference" = newer."providerReference"
   AND older."createdAt" < newer."createdAt";

-- CreateIndex
CREATE UNIQUE INDEX "VerificationCase_providerReference_key" ON "VerificationCase"("providerReference");

-- Drop the now-redundant non-unique index created alongside the column.
DROP INDEX IF EXISTS "VerificationCase_providerReference_idx";

-- A verification attempt that never settles must not block the player forever.
-- Without this, one lost webhook permanently locks them out of withdrawals: the
-- in-flight guard refuses a new attempt and nothing ever moves the case on.
ALTER TABLE "VerificationCase" ADD COLUMN "expiresAt" TIMESTAMP(3);

-- Drives the expiry sweep; partial so the common settled case stays off it.
CREATE INDEX "VerificationCase_expiresAt_pending_idx"
  ON "VerificationCase"("expiresAt")
  WHERE "status" IN ('STARTED', 'PENDING', 'UNDER_REVIEW');