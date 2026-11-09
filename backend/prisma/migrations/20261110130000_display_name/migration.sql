-- Optional display name. NULL = show the username. The app validates the characters
-- (Unicode rules) and computes display_name_key (NFKC + lower case) for uniqueness.
ALTER TABLE "users" ADD COLUMN "display_name" VARCHAR(20);
ALTER TABLE "users" ADD COLUMN "display_name_key" TEXT;

ALTER TABLE "users" ADD CONSTRAINT "users_display_name_check" CHECK (
    display_name IS NULL OR (
        char_length(display_name) BETWEEN 3 AND 20
        AND display_name = btrim(display_name)
        AND display_name !~ '[[:cntrl:]]'
    )
);
-- both set or both NULL
ALTER TABLE "users" ADD CONSTRAINT "users_display_name_key_pair_check" CHECK (
    (display_name IS NULL) = (display_name_key IS NULL)
);

CREATE UNIQUE INDEX "users_display_name_key_key" ON "users"("display_name_key");
