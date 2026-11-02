-- Leaderboard ordering and rank counting: ORDER BY rating DESC, username ASC,
-- and COUNT(*) WHERE rating > $1 OR (rating = $1 AND username < $2).
CREATE INDEX "users_rating_username_idx" ON "users"("rating" DESC, "username");

-- Per-player win/loss/draw aggregation (GROUP BY white_id|black_id, result).
CREATE INDEX "games_white_id_result_idx" ON "games"("white_id", "result");
CREATE INDEX "games_black_id_result_idx" ON "games"("black_id", "result");
