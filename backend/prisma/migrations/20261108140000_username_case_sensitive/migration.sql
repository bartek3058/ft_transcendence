-- Follow-up also supports databases that already applied case preservation.
BEGIN;
ALTER TABLE "users" ALTER COLUMN "username" TYPE VARCHAR(20) COLLATE "C"
  USING "username"::varchar(20);
-- The existing UNIQUE constraint now compares exact spelling, including case.
COMMIT;
