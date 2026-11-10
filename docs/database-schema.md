# Database Schema & Relations

All 10 tables and their foreign keys, from `backend/prisma/schema.prisma` and the SQL migrations in
`backend/prisma/migrations/` (latest: `20261110120000_username_case`). Names are the real PostgreSQL names
(`@@map` / `@map`), not the Prisma model names. Roles, setup and migrations: [database-setup.md](database-setup.md).

The diagrams are Mermaid, GitHub renders them directly.

## 1. ER Diagram

```mermaid
erDiagram
    users {
        uuid id PK
        varchar email UK "254, lowercase"
        varchar username UK "20, case kept, unique ignoring case"
        int rating "default 1200"
        text password_hash "argon2id"
        varchar role "user | admin | bot"
        varchar status "offline | online | in_game"
        timestamptz created_at
        timestamptz updated_at
    }

    sessions {
        uuid id PK
        uuid user_id FK
        varchar token_hash UK "sha256 hex"
        timestamptz created_at
        timestamptz expires_at
    }

    api_keys {
        uuid id PK
        uuid user_id FK
        varchar name
        varchar key_prefix
        varchar key_hash UK "sha256 hex"
        timestamptz last_used_at
        timestamptz expires_at
        timestamptz revoked_at
        timestamptz created_at
        timestamptz updated_at
    }

    friendships {
        uuid id PK
        uuid user_low_id FK "pair is ordered: low < high"
        uuid user_high_id FK
        uuid requested_by_id FK
        varchar status "PENDING | ACCEPTED"
        timestamptz created_at
        timestamptz accepted_at
    }

    games {
        uuid id PK
        uuid white_id FK "nullable"
        uuid black_id FK "nullable"
        varchar result "IN_PROGRESS | WHITE_WON | BLACK_WON | DRAW | ABORTED"
        varchar end_reason
        varchar time_control
        int white_rating "frozen pre-game snapshot"
        int black_rating "frozen pre-game snapshot"
        int white_rating_change "null = not rated"
        int black_rating_change "null = not rated"
        uuid tournament_id FK "nullable"
        uuid tournament_match_id FK "nullable"
        text pgn
        timestamptz game_start
        timestamptz game_end
        timestamptz created_at
        timestamptz updated_at
    }

    game_moves {
        uuid id PK
        uuid game_id FK
        int ply "unique per game"
        int move_number
        varchar color "WHITE | BLACK"
        uuid played_by_id FK "nullable"
        varchar san
        varchar uci
        varchar fen_after
        int time_spent_ms
        int time_remaining_ms
        timestamptz created_at
    }

    tournaments {
        uuid id PK
        varchar title
        varchar description
        uuid creator_id FK
        int max_participants
        int current_participants
        varchar status
        timestamptz registration_deadline
        timestamptz started_at
        timestamptz completed_at
        uuid champion_id FK "nullable"
        timestamptz created_at
        timestamptz updated_at
    }

    tournament_participants {
        uuid id PK
        uuid tournament_id FK
        uuid user_id FK
        int seed "unique per tournament"
        int seed_rating "frozen at registration close"
        int final_rank
        timestamptz registered_at
    }

    tournament_matches {
        uuid id PK
        uuid tournament_id FK
        int round
        int match_index
        varchar identifier "e.g. R1-M1"
        uuid player1_id FK "nullable"
        uuid player2_id FK "nullable"
        uuid winner_id FK "nullable"
        varchar status
        boolean is_bye
        uuid next_match_id FK "nullable, self"
        varchar next_match_slot "player1 | player2"
        timestamptz check_in_deadline
        timestamptz player1_checked_in_at
        timestamptz player2_checked_in_at
    }

    tournament_invitations {
        uuid id PK
        uuid tournament_id FK
        uuid sender_id FK
        uuid recipient_id FK
        varchar status
        timestamptz created_at
        timestamptz expires_at
    }

    %% accounts
    users ||--o{ sessions : "user_id (cascade)"
    users ||--o{ api_keys : "user_id (cascade)"
    users ||--o{ friendships : "user_low_id (cascade)"
    users ||--o{ friendships : "user_high_id (cascade)"
    users ||--o{ friendships : "requested_by_id (cascade)"

    %% games
    users |o--o{ games : "white_id (set null)"
    users |o--o{ games : "black_id (set null)"
    games ||--o{ game_moves : "game_id (cascade)"
    users |o--o{ game_moves : "played_by_id (set null)"

    %% tournaments
    users ||--o{ tournaments : "creator_id (restrict)"
    users |o--o{ tournaments : "champion_id (set null)"
    tournaments ||--o{ tournament_participants : "tournament_id (cascade)"
    users ||--o{ tournament_participants : "user_id (cascade)"
    tournaments ||--o{ tournament_matches : "tournament_id (cascade)"
    users |o--o{ tournament_matches : "player1_id (set null)"
    users |o--o{ tournament_matches : "player2_id (set null)"
    users |o--o{ tournament_matches : "winner_id (set null)"
    tournament_matches |o--o{ tournament_matches : "next_match_id (set null)"
    tournaments ||--o{ tournament_invitations : "tournament_id (cascade)"
    users ||--o{ tournament_invitations : "sender_id (cascade)"
    users ||--o{ tournament_invitations : "recipient_id (cascade)"

    %% games inside tournaments
    tournaments |o--o{ games : "tournament_id (set null)"
    tournament_matches |o--o{ games : "tournament_match_id (set null)"
```

**How to read it:** `||--o{` means one to zero-or-many with a required FK. `|o--o{` means the FK is nullable.
The label is the FK column and its `ON DELETE` rule.

## 2. Overview

The same relations without columns:

```mermaid
flowchart LR
    users((users))
    users --> sessions
    users --> api_keys
    users --> friendships
    users -->|white / black| games
    games --> game_moves
    users -->|creator / champion| tournaments
    tournaments --> tournament_participants
    tournaments --> tournament_matches
    tournaments --> tournament_invitations
    tournament_matches -->|next_match_id| tournament_matches
    tournament_matches -->|replays| games
    users -.-> tournament_participants
    users -.->|player1 / player2 / winner| tournament_matches
    users -.->|sender / recipient| tournament_invitations
```

## 3. What Happens on Delete

| Deleting a… | Effect |
| :--- | :--- |
| **user** | Their sessions, API keys, friendships, tournament entries and invitations are **deleted**. Their games, moves and tournament match slots **stay**, with the FK set to `NULL`, so other players keep their history. Blocked (`RESTRICT`) while they are the **creator** of any tournament. |
| **game** | Its `game_moves` are deleted. |
| **tournament** | Participants, matches and invitations are deleted. Its games stay, with `tournament_id` / `tournament_match_id` set to `NULL`. |
| **tournament match** | Matches pointing to it via `next_match_id` and its games get `NULL`. |

## 4. Keys and Rules Not Shown in the Diagram

**Unique**
- `users.email`, `sessions.token_hash`, `api_keys.key_hash`.
- `users_username_lower_key` on `lower(username)`: one username regardless of case (`Tom` blocks `tom`).
  It lives only in the SQL migration, `schema.prisma` can't express an index on an expression.
  See [account-settings.md](account-settings.md).
- `friendships (user_low_id, user_high_id)`: one row per pair, stored ordered (`friendships_order_check`).
- `game_moves (game_id, ply)`.
- `tournament_participants (tournament_id, user_id)` and `(tournament_id, seed)`.
- `tournament_matches (tournament_id, round, match_index)`.
- `tournament_invitations (tournament_id, recipient_id)`.
- Partial unique index `games_tournament_match_active_key` on `games(tournament_match_id)`: at most one live
  game per tournament match (SQL migration only).

**CHECK constraints** (in the SQL migrations, not in `schema.prisma`)
- `users`: canonical lowercase email, username `^[A-Za-z0-9_]{3,20}$`, role and status lists, non-empty password hash.
- `sessions` / `api_keys`: hash format (64 hex), expiry after creation.
- `friendships`: ordered pair, valid state, requester is one of the two.
- `games`: result list, `game_end >= game_start`.
- `game_moves`: color, `ply >= 1`, `move_number >= 1`, time spent `>= 0`.
- `tournaments`: title, participant bounds, status list, completed after started.
- `tournament_participants`: seed and final rank ranges.
- `tournament_matches`: round, status, next slot, two different players.
- `tournament_invitations`: status, expiry, not inviting yourself.

**Indexes worth knowing**
- `users (rating DESC, username)`: leaderboard order and rank counting.
- `games (white_id, result)`, `games (black_id, result)`: player records and match history.
- `sessions (expires_at)`: session cleanup. `tournament_matches (status, check_in_deadline)`: check-in sweep.

## 5. Design Notes

- **Frozen snapshots:** `games.white_rating` / `black_rating` + `*_rating_change` and
  `tournament_participants.seed_rating` are copies taken at the time. History, match details and the ELO
  progression read these, never the live `users.rating`.
- **History survives account deletion:** games, moves and match slots use `SET NULL`.
- **AI opponent** is a normal `users` row with `role = 'bot'` and a fixed id, so AI games use the same
  `white_id` / `black_id` FKs. They are never rated (`*_rating_change` stays `NULL`).
- **Live game state** (board, clocks) lives in backend memory. The DB holds the `IN_PROGRESS` row and every
  saved ply in `game_moves`, which is what restart recovery replays
  ([game-restart-recovery.md](game-restart-recovery.md)).
