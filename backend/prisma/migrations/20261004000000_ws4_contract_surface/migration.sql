-- WS4 — client idempotency key on deposit create (4.8). A replayed
-- `POST /wallet/deposit-intent` with the same Idempotency-Key returns the
-- original intent instead of opening a second provider checkout. NULLs stay
-- distinct in Postgres, so intents created without a key are unaffected.

ALTER TABLE "DepositIntent" ADD COLUMN "clientIdempotencyKey" TEXT;

CREATE UNIQUE INDEX "DepositIntent_userId_clientIdempotencyKey_key"
  ON "DepositIntent"("userId", "clientIdempotencyKey");