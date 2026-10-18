-- Private rooms. A PRIVATE match listing carries a shareable, unique room code
-- and is hidden from the public arena listing and from matchmaking queue
-- auto-seating; the only way in is the code. Additive: existing rows default to
-- PUBLIC and keep a NULL code, so listing and join behaviour is unchanged for
-- them.

ALTER TABLE "Match" ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'PUBLIC';
ALTER TABLE "Match" ADD COLUMN "roomCode" TEXT;

CREATE UNIQUE INDEX "Match_roomCode_key" ON "Match"("roomCode");
