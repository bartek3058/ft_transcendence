# Account Settings: Username & Password Change

## 1. Overview

A logged-in user can change their **username** or their **password**. Both routes live in the auth
module next to `GET /api/auth/me`, so they reuse its origin/CSRF guard, error format and Argon2id
password hashing.

At the same time usernames became **mixed case**: they keep the case they were typed in
(`Chess_Fan` stays `Chess_Fan`), while uniqueness ignores case (`Tom` blocks `tom`).

Login is still by email, so a username change never affects how someone signs in. Everything else
(games, moves, friendships, tournaments, sessions, API keys) references `users.id`, so history, ratings and
brackets stay intact after a rename.

---

## 2. Request Pipeline

Both routes run the checks in this order:

```
AuthRequestGuard   per-IP limit (60/min) + Origin == APP_ORIGIN + X-CSRF-Protection: 1   (no I/O)
SessionGuard       __Host-session cookie -> sessions table                              (DB read)
AuthValidationPipe raw-key check (only the listed keys, string values), then the DTO        (no I/O)
AccountRateLimiter per-user sliding window                                               (in memory)
AuthService        DB write / Argon2id
```

| Limit | Key | Rule |
| :--- | :--- | :--- |
| Username change | `username:<userId>` | 5 per hour |
| Password change | `password:<userId>` | 5 per 15 minutes, **wrong current-password guesses included** |

Limits use `SlidingWindowLimiter` (rolling timestamps, no fixed-window reset). A rejected request gets
`429 RATE_LIMITED` with a `Retry-After` header. All responses carry `Cache-Control: no-store`.

---

## 3. API

### A. Change username: `PATCH /api/auth/me`

```http
PATCH /api/auth/me
Origin: https://localhost
X-CSRF-Protection: 1
Cookie: __Host-session=...
Content-Type: application/json

{ "username": "Grand_Master" }
```

* The value is trimmed and must match `^[A-Za-z0-9_]{3,20}$`. Case is kept.
* Sending your current name returns 200 without writing anything.
* Changing only the case of your own name (`chess_fan` → `Chess_Fan`) is allowed.
* The session stays valid, a rename is not a re-login.

`200 OK`
```json
{ "user": { "id": "...", "email": "alice@example.com", "username": "Grand_Master", "createdAt": "..." } }
```

### B. Change password: `POST /api/auth/password`

```http
POST /api/auth/password
Origin: https://localhost
X-CSRF-Protection: 1
Cookie: __Host-session=...
Content-Type: application/json

{ "currentPassword": "my old long password", "newPassword": "a brand new chess password" }
```

* `newPassword` follows the registration policy (15–128 code points, max 512 UTF-8 bytes, kept exactly as typed).
* `currentPassword` only has to be non-empty, older accounts may have shorter passwords.

`204 No Content` with a new `Set-Cookie: __Host-session=...`. **Every other session of the user is
deleted**: other browsers and devices are signed out, and this browser carries on with the new cookie.

### C. Errors

All errors use the shared `{ "error": { "code", "message" } }` envelope and never echo the input.

| Status | Code | When |
| :--- | :--- | :--- |
| 400 | `INVALID_INPUT` | Bad format, missing field, non-string value, or an unexpected key |
| 400 | `INVALID_CURRENT_PASSWORD` | Current password is wrong. 400, not 401, so the client does not treat the session as expired |
| 400 | `PASSWORD_UNCHANGED` | New password equals the current one |
| 401 | `UNAUTHENTICATED` | No or expired session |
| 403 | `REQUEST_ORIGIN_REJECTED` | Wrong `Origin` or missing `X-CSRF-Protection: 1` |
| 409 | `USERNAME_TAKEN` | Another user has this name in any case |
| 409 | `PASSWORD_CHANGED_CONCURRENTLY` | The password changed between the check and the write (another request won) |
| 429 | `RATE_LIMITED` | Per-IP or per-user limit hit, see `Retry-After` |
| 503 | `AUTH_STORAGE_UNAVAILABLE` / `AUTH_BUSY` | Database down, or Argon2 busy |

---

## 4. Password Change Transaction

`AuthService.changePassword()` verifies the current password, hashes the new one, then calls
`SessionService.replaceAllWithPassword()`, which runs `PrismaAuthRepository.changePassword()` in **one
transaction**:

1. `UPDATE users SET password_hash = <new> WHERE id = <user> AND password_hash = <hash just verified>`.
   This is a compare-and-swap that also locks the user row, so two concurrent changes run one after the
   other and the loser writes nothing (`409 PASSWORD_CHANGED_CONCURRENTLY`).
2. `DELETE FROM sessions WHERE user_id = <user> RETURNING token_hash`. `RETURNING` gives exactly the rows
   removed, including a login that raced the change.
3. Insert the new session.

After commit, a `revoked` event is emitted for every dropped token hash. The friends and tournament
gateways already listen to it and disconnect those sockets.

---

## 5. Data Model: Mixed-Case Usernames

Migration `20261110120000_username_case`:

```sql
ALTER TABLE "users" DROP CONSTRAINT "users_username_check";
ALTER TABLE "users" ADD CONSTRAINT "users_username_check" CHECK (username ~ '^[A-Za-z0-9_]{3,20}$');
ALTER TABLE "users" DROP CONSTRAINT "users_username_key";
CREATE UNIQUE INDEX "users_username_lower_key" ON "users" (lower("username"));
```

* Existing names were all lowercase, so the migration can't hit duplicates.
* `schema.prisma` can't express an index on `lower(username)`, so `username` has no `@unique` there and
  the index lives only in the SQL. `prisma migrate diff` doesn't try to drop it.
* Prisma reports a clash on this index as `P2002` with `meta.target = ["lower(username::text)"]`, not
  with the index name. `PrismaAuthRepository` maps that to `AccountConflictError` (register: 409
  `ACCOUNT_CONFLICT`, rename: 409 `USERNAME_TAKEN`).
* The shared rule is `USERNAME_PATTERN` / `normalizeUsername()` in
  `backend/src/auth/validation/input-rules.ts` (trim only). Email is still lowercased.

### Case-insensitive lookups

| Where | How |
| :--- | :--- |
| `GET /api/v1/leaderboard/players/:username` | `SELECT id FROM users WHERE lower(username) = lower($1)`, served by the new index. `_` is literal, not a wildcard |
| `GET /api/users/search?q=` (friends) | Prefix search with `mode: 'insensitive'`, `q` is trimmed but no longer lowercased |
| `GET /api/v1/matches?username=` | Already case-insensitive, unchanged |

### Side effects of a rename

* The public URL `/api/v1/leaderboard/players/<old name>` returns 404. The same player is found under the new name.
* Ties on equal rating are ordered by username in byte order (`COLLATE "C"`), so uppercase sorts first
  (`Zed` before `adam`). Ranks stay consistent between the list and the single-player lookup.
* Opponents or friends with the page already open see the old name until they reload.
* A freed name can be taken by someone else.

### Registration

Registration uses the same rule as rename. `RegisterPage.tsx` used to lowercase the username
before validating and sending it, so new accounts were always lowercase even though the API and DB
accepted mixed case. Now the form only trims the name, checks it against `^[A-Za-z0-9_]{3,20}$`
(also set as the input `pattern`) and sends it as typed. Email is still lowercased.

* `Tomek` registers as `Tomek`. A later `tomek` or `TOMEK` gets 409 `ACCOUNT_CONFLICT`.
* Covered by `account-settings.test.cjs` ("a name that differs only in case…", the `BoBbY` register)
  and the `Chess_Fan` cases in `auth-http` / `auth-flows`.
* Manual check: register `Tomek_1`, then try `tomek_1` with another email. The form shows the
  conflict and the profile shows `Tomek_1`.

---

## 6. Testing & Verification

### Unit + HTTP tests (`npm test`)
`backend/test/account-settings.test.cjs` (10 tests) runs the real auth module over HTTP with the in-memory
repository: rename and case rules, case-insensitive conflicts, validation without echo, CSRF before session
before body, per-user limits with `Retry-After`, password change (new cookie, other sessions revoked, old
password rejected), wrong/unchanged password, the concurrent-change 409, and storage failures as 503.

```bash
docker compose run --rm backend npm test
```

### PostgreSQL integration test (8 tests)
Real index, CHECK constraint and transaction: case variants on create/rename, `VARCHAR(20)` and format
checks, session replacement for one user only, stale hash writes nothing, two concurrent changes with
exactly one winner, leaderboard lookup ignoring case with `_` literal, friends search in any case.

```bash
docker compose run --rm -e TEST_DATABASE_URL='<application-role URL for chess_test>' backend npm run test:account-settings:db
```

Apply the migration to `chess_test` first (`npx prisma migrate deploy` with the owner URL).

### Manual check

```bash
# log in and keep the cookie
curl -sk -c jar -H 'Origin: https://localhost' -H 'X-CSRF-Protection: 1' -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"<password>"}' https://localhost/api/auth/login
# rename
curl -sk -b jar -X PATCH -H 'Origin: https://localhost' -H 'X-CSRF-Protection: 1' -H 'Content-Type: application/json' \
  -d '{"username":"Grand_Master"}' https://localhost/api/auth/me
# change password (the jar gets the new cookie)
curl -sk -b jar -c jar -o /dev/null -w '%{http_code}\n' -H 'Origin: https://localhost' -H 'X-CSRF-Protection: 1' \
  -H 'Content-Type: application/json' -d '{"currentPassword":"<old>","newPassword":"<new, 15+ chars>"}' \
  https://localhost/api/auth/password
```
