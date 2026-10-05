# Database handoff: registration and login

Status: implementation contract, 2026-10-04. No database implementation is delivered by this document; independent auth validation/password foundations now exist in [stage 1](auth-stage-one.md). Stack: existing NestJS/Express + TypeScript backend, PostgreSQL, Prisma, React/Vite frontend and Nginx HTTPS proxy. This supersedes the earlier Fastify/Caddy proposal for this repository.

Scope: the database foundation needed by registration, login, authenticated-user lookup and logout. The local subject v21.1, III.2–III.3 (printed pp. 8–9), requires a database with clear relations, secure email/password authentication, concurrent correctness, validation on both sides, HTTPS externally and ignored local secrets. Our additional design decisions are identified below; the subject does not prescribe PostgreSQL, Prisma or sessions.

## 1. Ownership and deliverables

| Database teammate owns | Authentication developer owns |
|---|---|
| PostgreSQL Compose service, persistent volume, health check, database roles and environment wiring | Register/login/logout/me controllers and request DTOs |
| Prisma version/setup, schema, committed migrations and generated-client setup | Normalization, validation, Argon2id hashing and verification |
| Shared Nest DatabaseModule/PrismaService, connection lifecycle | UsersService, SessionService, auth guard and public response mapping |
| Database constraints/indexes and migration integration tests | Session token generation/hash, cookie settings, expiry checks, cleanup scheduling |
| Migration startup ordering and development/test database instructions | CSRF/origin checks, login throttling and auth flow tests |

Coordinate package.json/lockfile changes rather than independently selecting different Prisma versions. Keep one schema and one shared database provider. The database service supplies access, not password hashing, HTTP errors or cookies. The auth developer consumes it without creating another connection pool.

Requested delivery:

```text
backend/prisma/schema.prisma
backend/prisma/migrations/<timestamp>_auth_foundation/migration.sql
backend/src/database/database.module.ts
backend/src/database/prisma.service.ts
backend/<Prisma config if required by selected version>
backend/package.json and package-lock.json
docker-compose.yml
.env.example
docs/database-setup.md
```

Document the chosen compatible Node/Prisma/PostgreSQL versions. Auth stage 1 pins the backend to Node 22.23.3 and retains NestJS 10; coordinate Prisma compatibility with that baseline. The auth dependencies now have a lockfile. No Prisma/PostgreSQL version combination has been installed or tested for this contract yet.

## 2. Schema contract

Use Prisma model names `User` and `Session`, with database mappings `users` and `sessions`. Use camelCase Prisma fields and snake_case physical columns. IDs are application-generated UUIDs (Prisma defaults are acceptable); dates use PostgreSQL `timestamptz(3)` and UTC in API output. All fields below are NOT NULL. Do not add profile/game fields as required columns without defaults: registration must remain able to create an account with this contract.

### User (`users`)

| Prisma field | Database column/type | Rule |
|---|---|---|
| id | id UUID | Primary key; generated once; immutable identity |
| email | email VARCHAR(254), C collation | Unique canonical lowercase ASCII email; surrounding whitespace already removed |
| username | username VARCHAR(20), C collation | Unique canonical lowercase handle: `[a-z0-9_]{3,20}` |
| passwordHash | password_hash TEXT | Complete Argon2id encoded hash, including algorithm, parameters and salt |
| createdAt | created_at TIMESTAMPTZ(3) | Default current timestamp |
| updatedAt | updated_at TIMESTAMPTZ(3) | Default current timestamp; updated by Prisma on account updates |

Named unique constraints: `users_email_key` and `users_username_key`. Unique constraints, not pre-insert lookups, arbitrate concurrent registrations. No separate indexes are needed on these same columns just for equality lookup.

Add SQL checks to the migration for canonical storage:

```sql
CHECK (email = lower(email COLLATE "C")
       AND email !~ '[[:space:]]'
       AND octet_length(email) = char_length(email)
       AND char_length(email) BETWEEN 3 AND 254)
CHECK (username ~ '^[a-z0-9_]{3,20}$')
CHECK (char_length(password_hash) > 0)
```

The ASCII check assumes a UTF-8 database. Full email syntax belongs in the application validator, not a homemade SQL email regex. Configure C collation on identity columns in the migration so comparison behavior is deterministic. All writes, including seeds/admin tools, must follow the application normalization contract. SQL checks are a second line of defense, not a complete replacement for DTO validation.

The product explicitly treats the whole email as case-insensitive. This is an application policy, not a claim that all mail systems treat local parts that way. Preserve dots and plus-tags; never apply Gmail-style provider-specific alias rewriting. Restrict initial email support to conventional ASCII addresses (including already-punycoded domains), and document that internationalized mailbox support is deferred.

`username` is a lowercase public handle. A separate future `displayName` can preserve styling/Unicode; don't mix display identity with the unique login/account key. Login initially uses email, not username.

Use Prisma's update timestamp behavior for normal writes. If raw SQL updates User later, those queries must also update `updated_at`; do not imply a Prisma annotation is a database trigger.

### Session (`sessions`)

| Prisma field | Database column/type | Rule |
|---|---|---|
| id | id UUID | Primary key; independent of the bearer token |
| userId | user_id UUID | Foreign key to users.id, ON DELETE CASCADE |
| tokenHash | token_hash VARCHAR(64), C collation | Unique lowercase SHA-256 hex digest; check `^[0-9a-f]{64}$` |
| createdAt | created_at TIMESTAMPTZ(3) | Default current timestamp |
| expiresAt | expires_at TIMESTAMPTZ(3) | Supplied by auth; check `expires_at > created_at` |

Named unique constraint: `sessions_token_hash_key`. Add indexes on `user_id` for per-user revocation and `expires_at` for cleanup. Prisma relation fields: `User.sessions` and `Session.user`. Multiple sessions per user are allowed, for example separate browsers; `user_id` must not be unique.

The auth layer generates 32 cryptographically random bytes, encodes the token as unpadded base64url (43 characters), and stores only its SHA-256 digest. The raw token belongs solely in the secure browser cookie, never in DB rows, URLs, logs or JSON responses. Fast SHA-256 is appropriate for a high-entropy random token; passwords still need slow Argon2id hashing. Neither a separate salt column nor JWT fields are needed.

Proposed cookie: `__Host-session`, Secure, HttpOnly, SameSite=Lax, Path=/, no Domain, seven-day absolute expiry, no sliding extension. The auth service and cookie use the same expiry. Current-login replacement deletes the browser's existing session and creates a fresh one atomically; other browsers remain logged in. Registration creates an account without a session. Logout deletes the current session row and clears the cookie with matching scope.

Expired rows never authenticate, even before cleanup. Auth schedules bounded periodic deletion of expired rows (proposed hourly); deleting old rows is maintenance, not the validity check. No special cron container is required. Return 401 for absent/invalid/expired sessions; database outages are service errors, not wrong credentials.

## 3. Interface the auth code will consume

Export an injectable `PrismaService` from `DatabaseModule`. Expose the selected Prisma client's `user`, `session` and transaction operations through the agreed provider; adapter construction can vary by Prisma major, but that choice must be documented. Generated delegates must offer these logical operations:

| Operation | Behavior expected by auth |
|---|---|
| Create user | Insert canonical email/username and encoded password hash; return created record |
| Find user by email | Exact match against the canonical unique email; no case-insensitive scan needed |
| Create session | Persist userId, tokenHash, createdAt and expiresAt from one time reference |
| Find session | Look up unique tokenHash; include user only as needed; auth checks expiry |
| Delete session(s) | By token hash for logout, by userId for future account-wide revocation |
| Delete expired sessions | Bounded cleanup using expiry index |
| Transaction | Atomic replacement of the current browser session |

UsersService must explicitly select/map public `{id, email, username, createdAt}` fields for the account owner. Public profiles later must omit email. No ORM object is automatically a safe response DTO. Sessions and password hashes never leave backend internals.

Registration hashes outside long-running transactions, then inserts once. A unique-constraint conflict becomes an auth-layer 409 `ACCOUNT_CONFLICT`, with no raw DB error. A pre-check can improve UX but cannot replace the constraint. This policy can reveal that an identity is unavailable; use a generic combined email/username message and rate limits. Login uses one generic 401 `INVALID_CREDENTIALS` for unknown email or incorrect password, with a dummy Argon2 verification for missing users to reduce obvious timing differences.

Use parameterized Prisma operations. Never interpolate user data into raw SQL or use unsafe raw-query APIs. DB errors/logs must not expose credentials or submitted passwords.

## 4. Compose, configuration and migrations

Add a `postgres` service with a pinned supported image, named data volume and `pg_isready` health check. Do not publish a host database port in the normal Compose configuration. The backend connects to the Compose hostname `postgres`, not `localhost`. Test databases must be separate and must never share the development data volume.

Suggested variable contract (examples only, no real credentials):

```dotenv
POSTGRES_DB=chess
POSTGRES_USER=chess_owner
POSTGRES_PASSWORD=replace-with-local-owner-secret
APP_DB_USER=chess_app
APP_DB_PASSWORD=replace-with-local-app-secret
DATABASE_URL=postgresql://chess_app:replace-with-url-encoded-secret@postgres:5432/chess
MIGRATION_DATABASE_URL=postgresql://chess_owner:replace-with-url-encoded-secret@postgres:5432/chess
APP_ORIGIN=https://localhost
SESSION_TTL_SECONDS=604800
```

The DB teammate creates the application role and grants the minimum required schema usage and table CRUD privileges, including default privileges for future migrated tables. Docker's POSTGRES_USER is a bootstrap owner with broad privileges; do not run request handlers under it. Keep the migration/owner URL available to the migration process only. Use secrets from ignored .env files; compose's interpolation file does not automatically inject variables into containers, so wire them explicitly. Percent-encode URL credentials. Do not echo URLs in logs.

Maintain one migration history. Use the selected Prisma version's development migration workflow on a disposable dev database; apply committed migrations through a one-shot migration step after DB readiness and before the API becomes ready. The selected version's client generation and config must be reproducible from a locked install. Do not use automatic schema synchronization/db push as deployment history or reset a teammate's database to resolve migration conflicts.

The existing `make up`/`docker compose up --build` must remain the startup entry point after documented .env and TLS setup. A failed migration must stop API startup. Document persistent-volume initialization: initial DB bootstrap scripts do not automatically rerun on an existing volume. Provide a non-destructive upgrade path, not instructions to remove all volumes by default.

`make clean` currently uses `down -v` and deletes volumes; document that it will erase account data once PostgreSQL is added. Normal stop/down must preserve it.

The existing Nginx proxy terminates HTTPS; internal DB connections can be unencrypted under subject III.3. The auth/infrastructure work must fix local TLS SAN/trust, configure exact allowed origin and secure cookies, and avoid externally exposed plaintext backend ports. No switch to Caddy or Fastify is needed.

## 5. Database acceptance checklist

- [ ] Fresh Compose startup creates a usable schema through committed migrations; repeated startup preserves it.
- [ ] User can be created and queried through the shared Prisma service.
- [ ] Two concurrent inserts with the same canonical email or username produce exactly one user.
- [ ] Invalid canonical values are rejected by database checks; every seed uses the same normalization rules.
- [ ] Session for a missing user fails; multiple distinct sessions for one user succeed; duplicate token hashes fail.
- [ ] Expiry-before-creation fails; user deletion cascades sessions in an isolated test.
- [ ] Session lookup/cleanup/user-revocation indexes exist; expired rows remain invalid before cleanup runs.
- [ ] Restart preserves users/sessions. An isolated test database can be migrated and cleaned safely.
- [ ] Runtime role cannot create/drop tables; migrations use the separate owner connection.
- [ ] README/setup docs explain env variables, version selection, migration commands and destructive cleanup.

Auth tests will additionally verify hashing, cookie attributes, duplicate-registration error mapping, correct/wrong credentials, expiration, logout and CSRF. Passing DB tests alone does not establish a complete auth module.

## 6. Working in parallel

The auth developer can implement DTOs, normalization, response contracts and password/session services against an injected repository interface with test doubles. Production registration/login must use PostgreSQL; an in-memory test double must never become the deployment fallback. Integration is complete only after real-database and HTTPS tests pass.

Do not wait for game/tournament/chat tables to ship auth. Link those future entities to immutable users.id, not email or username. Agree deletion policies for game history separately; the session cascade is not a policy to cascade-delete all future user activity.

## References

- [Input and API contract](auth-input-contract.md)
- [PostgreSQL constraints](https://www.postgresql.org/docs/current/ddl-constraints.html): database-enforced integrity.
- [Prisma custom migrations](https://www.prisma.io/docs/orm/prisma-migrate/workflows/customizing-migrations): retain SQL constraints in committed migrations where needed; use docs for the selected major.
- [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html): token lifecycle and cookie protections.
