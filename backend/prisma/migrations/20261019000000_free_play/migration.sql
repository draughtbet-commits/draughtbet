-- Free play. A FREE_PLAY match is a solo game against the server bot: the bot
-- occupies one of the two seats, the stake is zero, no ledger entry is ever
-- written and the match is never rated. Additive — existing rows default to
-- RANKED and keep their current behaviour, and the bot columns stay NULL for
-- every competitive match.

ALTER TABLE "Match" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'RANKED';
ALTER TABLE "Match" ADD COLUMN "botLevel" INTEGER;
ALTER TABLE "Match" ADD COLUMN "botPlayerId" TEXT;

-- The free-play sweep and the "does this player hold a real match" guards
-- both filter on mode + status.
CREATE INDEX "Match_mode_status_idx" ON "Match"("mode", "status");
