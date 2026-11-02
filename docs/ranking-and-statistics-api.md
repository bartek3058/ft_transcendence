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
   - Exposed by `RatingController` for browser clients (session-based or unauthenticated visitors).
   - Returns paginated ELO rankings with total counts for the `/ranking` view.

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

### C. Individual Player Ranking (`GET /api/v1/leaderboard/:username`)
* **Headers**: `X-API-Key: <high-entropy-key>`
* **Behavior**: Case-insensitive username lookup. Returns exact global rank, rating, and match stats.
* **Error**: Returns `404 Not Found` with `{ "error": { "code": "PLAYER_NOT_FOUND", "message": "Player not found." } }` if the user does not exist.

### D. Web Leaderboard (`GET /api/leaderboard`)
* **Authentication**: None required (same-origin web consumption).
* **Query Parameters**: `limit` (default: `20`, max: `100`), `offset` (default: `0`).
* **Response Payload (`200 OK`)**:
```json
{
  "total": 3,
  "entries": [
    {
      "rank": 1,
      "id": "7f2eb46f-fda6-443e-9732-6f728b534fa7",
      "username": "admin",
      "rating": 1500
    }
  ]
}
```

---

## 3. Profile Statistics Enrichment

In `backend/src/profile/profile.service.ts`:
- `getMyProfile(userId)` now dynamically calculates:
  - `user.rank`: Global position derived from users with strictly higher ratings (and lexicographical tiebreaker).
  - `stats.rank`: Mirror of user rank.
  - `stats.winRate`: Calculated as `(wins / games) * 100` rounded to one decimal place.
  - Neutral fallback `"Unknown player"` for games where player accounts were deleted.

---

## 4. Frontend Integration

1. **`frontend/src/pages/RankingPage.tsx`**:
   - Replaced static `mockData` with live data fetched via `getLeaderboard(50, 0)` from `../services/leaderboard`.
   - Handles loading state, error display, and empty platform fallback.
   - Shows user ranks, avatar initial, username, and rating.

2. **`frontend/src/pages/HistoryPage.tsx`**:
   - Replaced static `mockData` with `getMyProfile()` from `../services/profile`.
   - Displays real current ELO, calculated win percentage, total completed games, and recent game cards with rating deltas.

---

## 5. Verification & Testing

### Running Tests in Docker
```bash
# Leaderboard & Rating Controller Unit Tests
docker compose run --rm backend npm run test:leaderboard:api

# Public API & Security Guard Regressions
docker compose run --rm backend npm run test:public-api
docker compose run --rm backend npm run test:api-guard

# Frontend Build & Typecheck
docker compose run --rm frontend npm run build
```
