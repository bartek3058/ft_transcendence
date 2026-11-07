-- The AI opponent (Stockfish) is seeded as a user with role 'bot' so games
-- against it can use the normal white_id/black_id foreign keys. The original
-- users_role_check only allowed 'user'/'admin', so widen it to include 'bot'.
-- Additive: every existing row already has an allowed role.
ALTER TABLE "users" DROP CONSTRAINT "users_role_check";
ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK (role IN ('user', 'admin', 'bot'));
