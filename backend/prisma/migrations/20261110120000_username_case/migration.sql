-- Usernames keep the case they were typed in, uniqueness ignores case ("Tom" blocks "tom").
ALTER TABLE "users" DROP CONSTRAINT "users_username_check";
ALTER TABLE "users" ADD CONSTRAINT "users_username_check" CHECK (username ~ '^[A-Za-z0-9_]{3,20}$');

-- schema.prisma can't express an index on lower(username), it only lives here.
ALTER TABLE "users" DROP CONSTRAINT "users_username_key";
CREATE UNIQUE INDEX "users_username_lower_key" ON "users" (lower("username"));
