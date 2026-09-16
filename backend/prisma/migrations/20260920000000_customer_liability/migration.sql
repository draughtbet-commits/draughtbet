-- Add a system contra account type for external deposits entering player float.
-- The singleton `system:CUSTOMER_LIABILITY:NGN` account is created lazily by
-- LedgerService.ensureSystemAccount when the first deposit is confirmed.
ALTER TYPE "AccountType" ADD VALUE 'CUSTOMER_LIABILITY';