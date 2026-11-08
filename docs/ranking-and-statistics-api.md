# Ranking & Global Statistics API (Issue #146)

This document provides a technical overview of the Ranking and Global Statistics API, encompassing the Public API endpoints under `/api/v1/leaderboard`, the web leaderboard route under `/api/leaderboard`, profile statistics enrichment, and frontend integration.

---

## 1. Architectural Overview

The statistics and ranking subsystem provides global and individual performance metrics across two distinct consumption layers:

1. **Machine-to-Machine Public API (`/api/v1/leaderboard`)**:
   - Authenticated via the `X-API-Key` header with `ApiKeyGuard`.
   - Protected by sliding-window rate limiting (60 req/min per key) via `ApiKeyRateLimiter`.
   - Documented via OpenAPI / Swagger at `/api/docs`.
   - Provides rich statistical projections: total matches played, wins, losses, draws, and win percentages.

2. **Web Frontend Endpoint (`/api/leaderboard`)**:
   - Exposed by `RatingController` for browser clients (no authentication required).
   - Validated by `WebLeaderboardQueryDto` and limited to 60 req/min per client IP by `WebLeaderboardGuard` (sliding window, checked before any DB query).
   - Returns paginated ELO rankings with total counts for the `/ranking` view.

**Who is ranked:** every ranking, count and statistic uses the shared filter `RANKED_USER_WHERE` (`backend/src/rating/ranked-users.ts`), which excludes accounts with `role = 'admin'`. Ties on rating are broken by username in byte order (`COLLATE "C"`), so the list position and the single-player rank always agree.

**Records:** wins/losses/draws are aggregated in PostgreSQL by `loadPlayerRecords` (`backend/src/rating/player-records.ts`) with two `GROUP BY` queries; only `WHITE_WON`, `BLACK_WON` and `DRAW` count (`IN_PROGRESS` and `ABORTED` are ignored). Supporting indexes: `users(rating DESC, username)`, `games(white_id, result)`, `games(black_id, result)` (migration `20261102230000_add_leaderboard_indexes`).

```
[ Frontend: RankingPage ] ----> GET /api/leaderboard?limit=50 ---------> [ RatingController / RatingService ]
                                                                                   |
[ External API Client   ] ----> GET /api/v1/leaderboard (X-API-Key) ---> [ LeaderboardController / LeaderboardService ]
                                                                                   |
                                                                          [ PostgreSQL Database (Prisma) ]
```

---

## 2. API Endpoints Reference

### A. Public API Leaderboard (`GET /api/v1/leaderboard`)
* **Headers**: `X-API-Key: <high-entropy-key>`
* **Query Parameters**:
  * `page` (integer, default: `1`, min: `1`)
  * `limit` (integer, default: `20`, min: `1`, max: `50` to prevent DB exhaustion)
* **Response Payload (`200 OK`)**:
```json
{
  "page": 1,
  "limit": 20,
  "total": 120,
  "totalPages": 6,
  "items": [
    {
      "rank": 1,
      "userId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "username": "grandmaster_bob",
      "rating": 1850,
      "gamesPlayed": 42,
      "wins": 25,
      "losses": 10,
      "draws": 7,
      "winRate": 59.5
    }
  ]
}
```

### B. Global Platform Statistics (`GET /api/v1/leaderboard/stats`)
* **Headers**: `X-API-Key: <high-entropy-key>`
* **Response Payload (`200 OK`)**:
```json
{
  "totalPlayers": 150,
  "totalMatches": 580,
  "averageRating": 1245,
  "highestRating": 2150,
  "topPlayer": {
    "username": "grandmaster_bob",
    "rating": 2150
  }
}
```

### C. Individual Player Ranking (`GET /api/v1/leaderboard/players/:username`)
* **Headers**: `X-API-Key: <high-entropy-key>`
* **Behavior**: The username is trimmed with capitalization preserved, then checked against `^[A-Za-z0-9_]{3,20}$` before any DB access, and looked up by exact match on the unique index. Returns global rank, rating, and match stats.
* **Errors**:
  * `400 Bad Request` — `{ "error": { "code": "INVALID_USERNAME", ... } }` for malformed input.
  * `404 Not Found` — `{ "error": { "code": "PLAYER_NOT_FOUND", "message": "Player not found." } }` if no ranked player has that username (admins included). The message never echoes the input.
* The `players/` segment keeps `stats` usable as a username.

### D. Web Leaderboard (`GET /api/leaderboard`)
* **Authentication**: None required (same-origin web consumption).
* **Rate limit**: 60 req/min per client IP; `429` with `Retry-After` when exceeded.
* **Query Parameters**: `limit` (integer 1–100, default `20`), `offset` (integer 0–10000, default `0`). Anything else returns `400 INVALID_INPUT`.
* **Response Payload (`200 OK`)**:
```json
{
  "total": 3,
  "entries": [
    {
      "rank": 1,
      "id": "7f2eb46f-fda6-443e-9732-6f728b534fa7",
      "username": "grandmaster_bob",
      "rating": 1850
    }
  ]
}
```

---

### E. Web Match History (`GET /api/profile/me/games`)
* **Authentication**: Session cookie (`SessionGuard`).
* **Query Parameters**: `page` (integer 1–1000, default `1`), `limit` (integer 1–50, default `20`).
* **Response**: `{ page, limit, total, totalPages, items[] }`, newest first; each item has `id`, `opponent`, `color`, `outcome` (`WIN`/`LOSS`/`DRAW`), `result`, `timeControl`, `ratingChange`, `playedAt`.

---

## 3. Profile Statistics Enrichment

In `backend/src/profile/profile.service.ts`:
- `getMyProfile(userId)` returns:
  - `user.rank` / `stats.rank`: global position among ranked (non-admin) players, same tie-break as the leaderboard.
  - `stats.games|wins|draws|losses|winRate`: from `loadPlayerRecords` (DB aggregation).
  - `recentGames`: the 8 most recent finished games (used by the profile page).
  - Neutral fallback `"Unknown player"` for games where player accounts were deleted.
- `getMyGames(userId, page, limit)` backs the full history endpoint above.

---

## 4. Frontend Integration

1. **`frontend/src/pages/RankingPage.tsx`**:
   - Fetches live data via `getLeaderboard(50, 0)` from `../services/leaderboard`.
   - Handles loading state, error display, and empty platform fallback.

2. **`frontend/src/pages/HistoryPage.tsx`**:
   - Stats cards from `getMyProfile()` (rating, rank, backend `winRate`, W/D/L).
   - Match list from `getMyGames()` with date, opponent, time control, outcome label and rating delta, plus a "Load more" button.

---

## 5. Verification & Testing

### Running Tests in Docker
```bash
# Leaderboard, validation, guard and history unit tests (no DB)
docker compose run --rm backend npm run test:leaderboard:api

# Real PostgreSQL checks (collation, GROUP BY, admin filter, indexes).
# Requires a disposable *_test database with migrations applied (see docs/database-setup.md).
docker compose run --rm -e TEST_DATABASE_URL='<application-role URL for chess_test>' backend npm run test:leaderboard:db

# Public API & Security Guard Regressions
docker compose run --rm backend npm run test:public-api
docker compose run --rm backend npm run test:api-guard

# Frontend Build & Typecheck
docker compose run --rm frontend npm run build
```
