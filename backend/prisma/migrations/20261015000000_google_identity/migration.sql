-- Google sign-in identity. The Google `sub` claim is the stable per-account
-- identifier (never the email, which a user can change), so it is stored to
-- recognise a returning Google user even if their email address changes.
--
-- Nullable because every existing and future password-only account has no
-- Google identity. Unique because two accounts must never both own the same
-- Google subject: that would let one Google login resolve to the wrong player.
-- Postgres permits repeated NULLs under a unique index, so password-only rows
-- are unaffected.
ALTER TABLE "User" ADD COLUMN "googleId" TEXT;

CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");
