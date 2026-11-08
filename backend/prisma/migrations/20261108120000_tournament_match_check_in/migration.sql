-- Tournament match check-in (#161): a SCHEDULED match gets a server-set check-in
-- deadline; both players must check in before it, or the deadline sweep resolves
-- the match (walkover for the absent player, double forfeit when nobody came).

ALTER TABLE "tournament_matches"
    ADD COLUMN "check_in_deadline" TIMESTAMPTZ(3),
    ADD COLUMN "player1_checked_in_at" TIMESTAMPTZ(3),
    ADD COLUMN "player2_checked_in_at" TIMESTAMPTZ(3);

-- Deadline sweep: SCHEDULED matches whose deadline has passed.
CREATE INDEX "tournament_matches_status_check_in_deadline_idx"
    ON "tournament_matches"("status", "check_in_deadline");

-- Matches that were already SCHEDULED before this migration get a fresh window,
-- otherwise the sweep would never see them.
UPDATE "tournament_matches"
SET "check_in_deadline" = now() + interval '5 minutes'
WHERE "status" = 'SCHEDULED' AND "check_in_deadline" IS NULL;
