-- PR 7: Withdrawal V2 — payout destination + reservation + provider state.
-- The Withdrawal/BankAccount tables already exist (v2_schema_additions). This
-- migration adds the fields the payout lifecycle needs and hardens the
-- idempotency key to user scope (a single-column unique index on idempotencyKey
-- allowed two different users to collide a global key — now scoped per user).
--
-- Statements are idempotent (guarded) so a retry after any partial apply
-- converges to the same final state.

-- Withdrawal: server-generated payout reference, currency, provider.
ALTER TABLE "Withdrawal" ADD COLUMN IF NOT EXISTS "reference" TEXT;
ALTER TABLE "Withdrawal" ADD COLUMN IF NOT EXISTS "currency" "Currency" NOT NULL DEFAULT 'NGN';
ALTER TABLE "Withdrawal" ADD COLUMN IF NOT EXISTS "gateway" "Gateway" NOT NULL DEFAULT 'PAYSTACK';

-- Replace the global-unique idempotencyKey index with a user-scoped one.
-- Prisma created the old one as a plain unique INDEX (not a constraint), so it
-- must be dropped as an index.
DROP INDEX IF EXISTS "Withdrawal_idempotencyKey_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Withdrawal_reference_key" ON "Withdrawal"("reference");
CREATE INDEX IF NOT EXISTS "Withdrawal_bankAccountId_idx" ON "Withdrawal"("bankAccountId");
CREATE UNIQUE INDEX IF NOT EXISTS "Withdrawal_userId_idempotencyKey_key" ON "Withdrawal"("userId", "idempotencyKey");

-- bankAccountId column + its Fkey already exist from v2_schema_additions.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='Withdrawal_bankAccountId_fkey') THEN
    ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_bankAccountId_fkey"
      FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- BankAccount: provider used to verify/pay, provider recipient ref and the
-- verified name returned by account-resolution.
ALTER TABLE "BankAccount" ADD COLUMN IF NOT EXISTS "gateway" "Gateway" NOT NULL DEFAULT 'PAYSTACK';
ALTER TABLE "BankAccount" ADD COLUMN IF NOT EXISTS "recipientRef" TEXT;
ALTER TABLE "BankAccount" ADD COLUMN IF NOT EXISTS "verifiedName" TEXT;

-- S01-style DB-level money invariants. Prisma does not model CHECK constraints
-- in schema.prisma, so these live here and are not tracked by schema drift.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_withdrawal_amount_positive') THEN
    ALTER TABLE "Withdrawal" ADD CONSTRAINT "chk_withdrawal_amount_positive" CHECK ("amountMinorUnits" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_bank_account_number_length') THEN
    ALTER TABLE "BankAccount" ADD CONSTRAINT "chk_bank_account_number_length"
      CHECK (length("accountNumber") BETWEEN 6 AND 20);
  END IF;
END $$;