CREATE TABLE "friendships" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_low_id" UUID NOT NULL,
  "user_high_id" UUID NOT NULL,
  "requested_by_id" UUID NOT NULL,
  "status" VARCHAR(8) NOT NULL DEFAULT 'PENDING',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "accepted_at" TIMESTAMPTZ(3),
  CONSTRAINT "friendships_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "friendships_pair_key" UNIQUE ("user_low_id", "user_high_id"),
  CONSTRAINT "friendships_order_check" CHECK (user_low_id < user_high_id),
  CONSTRAINT "friendships_requester_check" CHECK (requested_by_id IN (user_low_id, user_high_id)),
  CONSTRAINT "friendships_state_check" CHECK (
    (status = 'PENDING' AND accepted_at IS NULL) OR
    (status = 'ACCEPTED' AND accepted_at IS NOT NULL AND accepted_at >= created_at)
  ),
  CONSTRAINT "friendships_low_fkey" FOREIGN KEY (user_low_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "friendships_high_fkey" FOREIGN KEY (user_high_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "friendships_requester_fkey" FOREIGN KEY (requested_by_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "friendships_user_low_id_status_created_at_idx" ON friendships(user_low_id, status, created_at);
CREATE INDEX "friendships_user_high_id_status_created_at_idx" ON friendships(user_high_id, status, created_at);
