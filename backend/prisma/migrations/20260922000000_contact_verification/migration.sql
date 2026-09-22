-- Contact verification + password reset.

-- User gains verified-contact flags used by /auth/verify/confirm and surfaced
-- on /me. Challenge purpose enum is repurposed from EMAIL/PHONE (unused) to
-- purpose-scoped values so a verify code can never replay as a reset code.

ALTER TABLE "User" ADD COLUMN     "emailVerified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN     "phoneVerified" BOOLEAN NOT NULL DEFAULT false;

-- ChallengeType before: ('EMAIL', 'PHONE') — no rows reference it yet, so it
-- can be rebuilt in place.
ALTER TYPE "ChallengeType" RENAME TO "ChallengeType_old";
CREATE TYPE "ChallengeType" AS ENUM ('EMAIL_VERIFY', 'PHONE_VERIFY', 'PASSWORD_RESET');
ALTER TABLE "VerificationChallenge" ALTER COLUMN "type" DROP DEFAULT;
ALTER TABLE "VerificationChallenge" ALTER COLUMN "type" TYPE "ChallengeType" USING ("type"::text::"ChallengeType");
DROP TYPE "ChallengeType_old";