-- S05: a Match row must never pair a player against themselves. Enforced in
-- the service (IdenticalPlayersError) and at the schema level so a self-match
-- can never be funded even if a caller bypasses the service.
ALTER TABLE "Match" ADD CONSTRAINT "chk_match_players_distinct" CHECK ("playerLightId" <> "playerDarkId");