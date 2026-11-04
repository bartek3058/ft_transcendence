-- CreateTable: tournaments
CREATE TABLE "tournaments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" VARCHAR(64) NOT NULL,
    "description" VARCHAR(255),
    "creator_id" UUID NOT NULL,
    "max_participants" INTEGER NOT NULL,
    "current_participants" INTEGER NOT NULL DEFAULT 0,
    "status" VARCHAR(24) NOT NULL DEFAULT 'OPEN_FOR_SIGNUP',
    "registration_deadline" TIMESTAMPTZ(3) NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "champion_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tournaments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tournaments_title_check" CHECK (char_length(btrim("title")) >= 3),
    CONSTRAINT "tournaments_max_participants_check" CHECK ("max_participants" IN (2, 4, 8, 16, 32)),
    CONSTRAINT "tournaments_participants_bound_check" CHECK ("current_participants" >= 0 AND "current_participants" <= "max_participants"),
    CONSTRAINT "tournaments_status_check" CHECK ("status" IN ('OPEN_FOR_SIGNUP', 'REGISTRATION_CLOSED', 'IN_PROGRESS', 'FINISHED', 'CANCELLED')),
    CONSTRAINT "tournaments_completed_after_started_check" CHECK ("completed_at" IS NULL OR "started_at" IS NULL OR "completed_at" >= "started_at")
);

-- CreateTable: tournament_participants
CREATE TABLE "tournament_participants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tournament_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "seed" INTEGER,
    "seed_rating" INTEGER,
    "final_rank" INTEGER,
    "registered_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tournament_participants_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tournament_participants_user_unique" UNIQUE ("tournament_id", "user_id"),
    -- NULLs are distinct in Postgres, so unseeded rows (seed IS NULL) never collide.
    CONSTRAINT "tournament_participants_seed_unique" UNIQUE ("tournament_id", "seed"),
    CONSTRAINT "tournament_participants_seed_check" CHECK ("seed" IS NULL OR "seed" >= 1),
    CONSTRAINT "tournament_participants_final_rank_check" CHECK ("final_rank" IS NULL OR "final_rank" >= 1)
);

-- CreateTable: tournament_matches
CREATE TABLE "tournament_matches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tournament_id" UUID NOT NULL,
    "round" INTEGER NOT NULL,
    "match_index" INTEGER NOT NULL,
    "identifier" VARCHAR(16) NOT NULL,
    "player1_id" UUID,
    "player2_id" UUID,
    "winner_id" UUID,
    "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    "is_bye" BOOLEAN NOT NULL DEFAULT false,
    "next_match_id" UUID,
    "next_match_slot" VARCHAR(16),

    CONSTRAINT "tournament_matches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tournament_matches_round_index_unique" UNIQUE ("tournament_id", "round", "match_index"),
    CONSTRAINT "tournament_matches_status_check" CHECK ("status" IN ('PENDING', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'WALKOVER')),
    CONSTRAINT "tournament_matches_round_check" CHECK ("round" >= 1 AND "match_index" >= 0),
    CONSTRAINT "tournament_matches_next_slot_check" CHECK ("next_match_slot" IS NULL OR "next_match_slot" IN ('player1', 'player2')),
    CONSTRAINT "tournament_matches_distinct_players_check" CHECK ("player1_id" IS NULL OR "player2_id" IS NULL OR "player1_id" <> "player2_id")
);

-- CreateTable: tournament_invitations
CREATE TABLE "tournament_invitations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tournament_id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tournament_invitations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tournament_invitations_recipient_unique" UNIQUE ("tournament_id", "recipient_id"),
    CONSTRAINT "tournament_invitations_status_check" CHECK ("status" IN ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED')),
    CONSTRAINT "tournament_invitations_expiry_check" CHECK ("expires_at" > "created_at"),
    CONSTRAINT "tournament_invitations_not_self_check" CHECK ("sender_id" <> "recipient_id")
);

-- AlterTable: games add tournament linkage
ALTER TABLE "games" ADD COLUMN "tournament_id" UUID;
ALTER TABLE "games" ADD COLUMN "tournament_match_id" UUID;

-- Indexes
CREATE INDEX "tournaments_status_registration_deadline_idx" ON "tournaments"("status", "registration_deadline");
CREATE INDEX "tournaments_creator_id_idx" ON "tournaments"("creator_id");

CREATE INDEX "tournament_participants_user_id_idx" ON "tournament_participants"("user_id");

CREATE INDEX "tournament_matches_tournament_id_round_idx" ON "tournament_matches"("tournament_id", "round");
CREATE INDEX "tournament_matches_player1_id_idx" ON "tournament_matches"("player1_id");
CREATE INDEX "tournament_matches_player2_id_idx" ON "tournament_matches"("player2_id");
CREATE INDEX "tournament_matches_next_match_id_idx" ON "tournament_matches"("next_match_id");

CREATE INDEX "tournament_invitations_recipient_id_status_idx" ON "tournament_invitations"("recipient_id", "status");
CREATE INDEX "tournament_invitations_sender_id_idx" ON "tournament_invitations"("sender_id");

CREATE INDEX "games_tournament_id_idx" ON "games"("tournament_id");
CREATE INDEX "games_tournament_match_id_idx" ON "games"("tournament_match_id");
-- At most one live game per tournament match (a drawn game may be followed by a tiebreak game).
CREATE UNIQUE INDEX "games_tournament_match_active_key" ON "games"("tournament_match_id")
    WHERE "tournament_match_id" IS NOT NULL AND "result" = 'IN_PROGRESS';

-- Foreign Keys
ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_champion_id_fkey" FOREIGN KEY ("champion_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "tournament_participants" ADD CONSTRAINT "tournament_participants_tournament_id_fkey" FOREIGN KEY ("tournament_id") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tournament_participants" ADD CONSTRAINT "tournament_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_tournament_id_fkey" FOREIGN KEY ("tournament_id") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_player1_id_fkey" FOREIGN KEY ("player1_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_player2_id_fkey" FOREIGN KEY ("player2_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_winner_id_fkey" FOREIGN KEY ("winner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_next_match_id_fkey" FOREIGN KEY ("next_match_id") REFERENCES "tournament_matches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "tournament_invitations" ADD CONSTRAINT "tournament_invitations_tournament_id_fkey" FOREIGN KEY ("tournament_id") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tournament_invitations" ADD CONSTRAINT "tournament_invitations_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tournament_invitations" ADD CONSTRAINT "tournament_invitations_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "games" ADD CONSTRAINT "games_tournament_id_fkey" FOREIGN KEY ("tournament_id") REFERENCES "tournaments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "games" ADD CONSTRAINT "games_tournament_match_id_fkey" FOREIGN KEY ("tournament_match_id") REFERENCES "tournament_matches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
