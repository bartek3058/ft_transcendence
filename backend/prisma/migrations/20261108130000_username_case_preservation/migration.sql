-- Preserve spelling while enforcing case-insensitive uniqueness, including concurrent writes.
BEGIN;
CREATE EXTENSION IF NOT EXISTS citext;
ALTER TABLE "users" DROP CONSTRAINT "users_username_check";
ALTER TABLE "users" ALTER COLUMN "username" TYPE CITEXT USING "username"::citext;
-- Cast to text to enforce the ASCII allowlist and length independently of citext.
ALTER TABLE "users" ADD CONSTRAINT "users_username_check"
  CHECK (username::text ~ '^[A-Za-z0-9_]{3,20}$');
COMMIT;
