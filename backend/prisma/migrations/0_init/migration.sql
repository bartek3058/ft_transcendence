-- CreateTable: users
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" VARCHAR(254) COLLATE "C" NOT NULL,
    "username" VARCHAR(20) COLLATE "C" NOT NULL,
    "rating" INTEGER NOT NULL DEFAULT 1200,
    "password_hash" TEXT NOT NULL,
    "role" VARCHAR(20) NOT NULL DEFAULT 'user',
    "status" VARCHAR(20) NOT NULL DEFAULT 'offline',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "users_email_key" UNIQUE ("email"),
    CONSTRAINT "users_username_key" UNIQUE ("username"),
    CONSTRAINT "users_email_canonical_check" CHECK (
        email = lower(email COLLATE "C")
        AND email !~ '[[:space:]]'
        AND octet_length(email) = char_length(email)
        AND char_length(email) BETWEEN 3 AND 254
    ),
    CONSTRAINT "users_username_check" CHECK (username ~ '^[a-z0-9_]{3,20}$'),
    CONSTRAINT "users_password_hash_check" CHECK (char_length(password_hash) > 0),
    CONSTRAINT "users_role_check" CHECK (role IN ('user', 'admin')),
    CONSTRAINT "users_status_check" CHECK (status IN ('offline', 'online', 'in_game'))
);

-- CreateTable: sessions
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) COLLATE "C" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sessions_token_hash_key" UNIQUE ("token_hash"),
    CONSTRAINT "sessions_token_hash_check" CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "sessions_expiry_check" CHECK (expires_at > created_at)
);

-- CreateTable: games
CREATE TABLE "games" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "white_id" UUID,
    "black_id" UUID,
    "result" VARCHAR(16) NOT NULL DEFAULT 'IN_PROGRESS',
    "end_reason" VARCHAR(32),
    "time_control" VARCHAR(32),
    "white_rating" INTEGER,
    "black_rating" INTEGER,
    "white_rating_change" INTEGER,
    "black_rating_change" INTEGER,
    "pgn" TEXT,
    "game_start" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "game_end" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "games_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "games_result_check" CHECK (result IN ('WHITE_WON', 'BLACK_WON', 'DRAW', 'IN_PROGRESS', 'ABORTED')),
    CONSTRAINT "games_end_after_start_check" CHECK (game_end IS NULL OR game_end >= game_start)
);

-- CreateTable: game_moves
CREATE TABLE "game_moves" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "game_id" UUID NOT NULL,
    "ply" INTEGER NOT NULL,
    "move_number" INTEGER NOT NULL,
    "color" VARCHAR(5) NOT NULL,
    "played_by_id" UUID,
    "san" VARCHAR(10) COLLATE "C" NOT NULL,
    "uci" VARCHAR(10) COLLATE "C" NOT NULL,
    "fen_after" VARCHAR(100) NOT NULL,
    "time_spent_ms" INTEGER,
    "time_remaining_ms" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_moves_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "game_moves_game_id_ply_key" UNIQUE ("game_id", "ply"),
    CONSTRAINT "game_moves_ply_check" CHECK (ply >= 1),
    CONSTRAINT "game_moves_move_number_check" CHECK (move_number >= 1),
    CONSTRAINT "game_moves_color_check" CHECK (color IN ('WHITE', 'BLACK')),
    CONSTRAINT "game_moves_time_spent_check" CHECK (time_spent_ms IS NULL OR time_spent_ms >= 0)
);

-- Indexes
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");
CREATE INDEX "games_white_id_idx" ON "games"("white_id");
CREATE INDEX "games_black_id_idx" ON "games"("black_id");
CREATE INDEX "games_game_start_idx" ON "games"("game_start");
CREATE INDEX "game_moves_game_id_ply_idx" ON "game_moves"("game_id", "ply" ASC);

-- Foreign Keys
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "games" ADD CONSTRAINT "games_white_id_fkey" FOREIGN KEY ("white_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "games" ADD CONSTRAINT "games_black_id_fkey" FOREIGN KEY ("black_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "game_moves" ADD CONSTRAINT "game_moves_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "game_moves" ADD CONSTRAINT "game_moves_played_by_id_fkey" FOREIGN KEY ("played_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
