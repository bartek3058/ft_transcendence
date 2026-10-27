# Public API Architecture and Integration Contract

Status updated 2026-10-27. Implements the **IV.1 Web Major Module (2 Points)** and resolves **Issue #90 (Match history API)**.

---

## 1. Overview & Subject Requirements

The ft_transcendence Public API exposes machine-to-machine, stateless HTTP interfaces to external consumers, developer scripts, and evaluators without requiring browser session cookies.

### 42 Subject Requirements Checklist
* **Secured API Key**: Authenticated via HTTP request header (`X-API-Key`). Plaintext keys are never persisted in PostgreSQL; only high-entropy SHA-256 hashes (`key_hash`) are stored.
* **Rate Limiting**: Sliding-window traffic limiter (default: 60 req/min per key) returning HTTP `429 Too Many Requests` with a standard `Retry-After: <seconds>` header.
* **Interactive Documentation**: OpenAPI 3.0 specification auto-generated from NestJS DTOs/controllers, served with Swagger UI at `/api/docs`.
* **CRUD Lifecycle (≥ 5 Endpoints)**: Complete persistence lifecycle implemented on `api_keys` (`POST`, `GET`, `GET :id`, `PUT`, `DELETE`).
* **Match History (Issue #90)**: Paginated match queries, outcomes, player ratings, PGN, and ply-by-ply move records (`GET /matches`, `GET /matches/:id`).

---

## 2. Security Architecture

### Key Generation & Cryptographic Storage
1. **Entropy & Prefix**: Keys use the format `tr_live_<64 hex characters>` (72 characters total), generated via `crypto.randomBytes(32).toString('hex')`.
2. **Zero Plaintext Storage**: The database table `api_keys` stores only:
   * `key_hash`: `VARCHAR(64)` storing `sha256(raw_key)`.
   * `key_prefix`: `VARCHAR(16)` storing the public prefix (e.g. `tr_live_a8f9...`) for safe identification in dashboards.
3. **Audit & Expiration**:
   * `last_used_at`: Updated asynchronously on authenticated requests without blocking the critical response path.
   * `expires_at`: Optional expiration timestamp. Expired keys are rejected with `401 API_KEY_EXPIRED`.
   * `revoked_at`: Soft-revocation kill-switch. Setting `revoked_at` immediately invalidates the key (`401 API_KEY_REVOKED`) while preserving historical audit trails.

### Request Pipeline & Defense in Depth
```
External Client / Evaluator
  │ (HTTPS / TLS)
  ▼
Nginx Reverse Proxy
  │ (/api/ reverse proxied to NestJS:3000)
  ▼
ApiKeyGuard
  ├─ 1. Header Extraction: Read 'x-api-key'
  ├─ 2. Format Pre-Validation: Regex check (^tr_live_[0-9a-f]{64}$)
  ├─ 3. DB Hash Lookup: Query PostgreSQL by sha256(raw_key)
  ├─ 4. Revocation & Expiry Checks: Ensure revoked_at IS NULL & expires_at > NOW()
  ├─ 5. Rate Limiting: ApiKeyRateLimiter.consume(keyId, 60, 60000)
  └─ 6. Attach Context: req.apiKeyUser and req.apiKeyId
  ▼
MatchesController / ApiKeysController
```

1. **Pre-Query Sanitization**: Malformed keys, SQL-injection patterns, or oversized headers are rejected at step 2 with `401 INVALID_API_KEY_FORMAT` before executing any database queries.
2. **Rate Limiting**:
   * In-memory token bucket / sliding window per API key ID.
   * Memory storage is strictly bounded (capacity: 10,000 active keys) to prevent memory exhaustion attacks.
   * Exceeding the quota throws a `PublicApiRetryException` resulting in HTTP `429` with `Retry-After: <seconds>`.
3. **Information Disclosure Prevention**:
   * `PublicApiExceptionFilter` intercepts all unhandled errors.
   * Responses enforce `Cache-Control: no-store`.
   * Internal database or driver errors are masked into a clean, safe payload:
     `{ "error": { "code": "INTERNAL_SERVER_ERROR", "message": "An internal server error occurred." } }`

---

## 3. Interactive Documentation (Swagger UI)

Evaluators can explore and test all endpoints interactively:
1. Open **`https://localhost/api/docs`** in Google Chrome.
2. Click the green **Authorize** button at the top right.
3. Enter the pre-seeded evaluation key:
   ```text
   tr_live_evaluator000000000000000000000000000000000000000000000000000000
   ```
4. Click **Authorize** -> **Close**.
5. Select any endpoint (e.g., `GET /v1/matches`), click **Try it out**, and click **Execute**.

---

## 4. Complete Endpoints Specification

### Matches (Issue #90)

#### `GET /api/v1/matches`
Lists match history with pagination and optional filters.
* **Headers**: `X-API-Key: <key>`
* **Query Parameters**:
  * `page` (optional integer $\ge 1$, default: `1`)
  * `limit` (optional integer, min: `1`, max: `50`, default: `10`)
  * `username` (optional string, case-insensitive match against white or black player)
  * `result` (optional enum: `ALL`, `WHITE_WON`, `BLACK_WON`, `DRAW`, `IN_PROGRESS`)
* **Success Response (200)**:
  ```json
  {
    "items": [
      {
        "id": "11111111-1111-1111-1111-111111111111",
        "result": "WHITE_WON",
        "endReason": "CHECKMATE",
        "timeControl": "10+0",
        "whiteRatingChange": 16,
        "blackRatingChange": -16,
        "gameStart": "2026-10-27T10:00:00.000Z",
        "gameEnd": "2026-10-27T10:05:00.000Z",
        "whitePlayer": { "id": "...", "username": "magnus", "rating": 2800 },
        "blackPlayer": { "id": "...", "username": "hikaru", "rating": 2780 }
      }
    ],
    "total": 1,
    "page": 1,
    "limit": 10,
    "totalPages": 1
  }
  ```

#### `GET /api/v1/matches/:id`
Retrieves full match details and ply-by-ply move records.
* **Headers**: `X-API-Key: <key>`
* **Path Parameter**: `:id` (UUID format, rejected with `400` if invalid).
* **Errors**: `400 INVALID_MATCH_ID`, `404 MATCH_NOT_FOUND`.
* **Success Response (200)**:
  ```json
  {
    "id": "11111111-1111-1111-1111-111111111111",
    "result": "WHITE_WON",
    "endReason": "CHECKMATE",
    "timeControl": "10+0",
    "whiteRatingChange": 16,
    "blackRatingChange": -16,
    "pgn": "1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0",
    "whitePlayer": { "id": "...", "username": "magnus", "rating": 2800 },
    "blackPlayer": { "id": "...", "username": "hikaru", "rating": 2780 },
    "moves": [
      {
        "ply": 1,
        "moveNumber": 1,
        "color": "WHITE",
        "san": "e4",
        "uci": "e2e4",
        "fenAfter": "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
        "timeSpentMs": 1200,
        "timeRemainingMs": 598800
      }
    ]
  }
  ```

---

### API Keys CRUD Lifecycle (Subject ≥ 5 Endpoints Requirement)

#### `POST /api/v1/api-keys`
Creates a new API key. The raw plaintext `apiKey` is returned **only once** upon creation.
* **Headers**: `X-API-Key: <key>` or Session Cookie
* **Body**:
  ```json
  {
    "name": "CLI Script",
    "expiresInDays": 30
  }
  ```
* **Success Response (201)**:
  ```json
  {
    "id": "c8b417e2-...",
    "name": "CLI Script",
    "keyPrefix": "tr_live_a8f9c2d4",
    "apiKey": "tr_live_a8f9c2d4e6f80123456789abcdef0123456789abcdef0123456789abcdef01",
    "createdAt": "2026-10-27T14:30:00.000Z",
    "expiresAt": "2026-11-26T14:30:00.000Z"
  }
  ```

#### `GET /api/v1/api-keys`
Lists active keys for the caller (or all keys if caller has role `admin`).
* **Headers**: `X-API-Key: <key>` or Session Cookie
* **Success Response (200)**: Array of key metadata (omits `keyHash` and raw key).

#### `GET /api/v1/api-keys/:id`
Retrieves metadata for a specific key. Enforces ownership or admin role.

#### `PUT /api/v1/api-keys/:id`
Updates key label/name.
* **Headers**: `X-API-Key: <key>` or Session Cookie
* **Body**: `{ "name": "Production Bot" }`
* **Success Response (200)**: Updated key metadata.

#### `DELETE /api/v1/api-keys/:id`
Revokes an API key.
* **Headers**: `X-API-Key: <key>` or Session Cookie
* **Query Parameters**: `?purge=true` (admin only: permanently deletes record from DB).
* **Success Response (200)**: `{ "message": "API key revoked successfully." }`

---

## 5. Automated Verification Commands

All test suites can be executed inside Docker:

```bash
# 1. Matches & API Keys CRUD lifecycle tests (12 tests)
docker compose run --rm backend npm run test:public-api

# 2. Security guard, rate limiter, and injection resistance tests (12 tests)
docker compose run --rm backend npm run test:api-guard

# 3. Core API key entropy, hashing, and revocation tests (5 tests)
docker compose run --rm backend npm run test:apikey
```
