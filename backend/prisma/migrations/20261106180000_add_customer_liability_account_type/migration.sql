-- Ensure CUSTOMER_LIABILITY is present in AccountType enum on databases that were
-- migrated prior to the inline enum addition.
ALTER TYPE "AccountType" ADD VALUE IF NOT EXISTS 'CUSTOMER_LIABILITY';

