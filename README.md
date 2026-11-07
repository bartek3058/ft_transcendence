*This project has been created as part of the 42 curriculum by astefans, brogalsk, tszymans, pjedrycz and pmamala*

# ft_transcendence

## Description

A full-stack **chess** app you play in the browser: real-time multiplayer over WebSockets, matchmaking, ELO ranking, player stats, and — further down the line — tournaments and an AI opponent.

### Goal
Build a chess app with multiplayer, tournaments, a scoring/ranking system and AI.

### Features
- **Authentication & security** - registration, login, cookie sessions, CSRF checks, rate limiting (Argon2id password hashing).
- **Real-time chess gameplay** - authoritative server-side engine with move validation and turn ownership.
- **Matchmaking & ranking** - waiting queue, ELO-based automated opponent matching, player rating.
- **User profiles & statistics** - per-user profile with win/loss/draw record and recent games.
- **Public API, Match History & Leaderboard** - secured API keys (SHA-256), sliding-window rate limiting (60 req/min), interactive Swagger UI (`/api/docs`), match history queries, global ELO leaderboard, and platform statistics.
- **Game conclusion & ELO rating trigger** - authoritative match conclusion resolution (checkmate, stalemate, draws, resignation, timeouts), atomic PostgreSQL persistence, and automatic ELO rating updates.
- **Tournament bracket & progression engine** - automated single-elimination tournament generator with balanced seed-fold pairing, Round 1 Bye resolution, match progression to champion, and knockout draw tiebreak handling.
- _TODO: tournament registration API / lobby UI, AI opponent, live chat, internationalization._

---

# Instructions

## Prerequisites
- A container engine: **Docker** (with the **Docker Compose v2** plugin, i.e. `docker compose`)
- **GNU Make**
- **OpenSSL** (used to generate the development TLS certificate)

```bash
docker --version
docker compose version
make --version
```

## Installation
```bash
git clone git@github.com:bartek3058/ft_transcendence.git
cd ft_transcendence
```

## Environment Configuration
Copy the example environment file and fill in real secrets:
```bash
cp .env.example .env
# edit .env: set POSTGRES_PASSWORD / APP_DB_PASSWORD / ADMIN_PASSWORD, and make sure the
# passwords inside DATABASE_URL and MIGRATION_DATABASE_URL match the ones above.
make up
```
> **Do not commit `.env` or any secret files.** Only `.env.example` is tracked.

## HTTPS
Nginx handles TLS (with a self-signed cert baked into the image) and proxies the frontend, the REST API and the Socket.IO connection. Everything's served at `https://localhost` - plain HTTP on port 80 just redirects to HTTPS.

---

# Team Information

## Team

| Member | Role | Main Responsibilities |
|--------|------|-----------------------|
| tszymans | Product Owner | _TODO_ |
| pjedrycz | Tech Lead | _TODO_ |
| brogalsk | Project Manager | _TODO_ |
| astefans | Developer | Matchmaking, ELO ranking and game statistics |
| pmamala | Developer | _TODO_ |

## Project Management
- **GitHub Issues & Projects** - task tracking and board.
- **Feature-branch Git workflow** - one feature per pull request, reviewed before merge to `main`.
- **Trello** - storing notes, references/sources and documentation.
- **Slack** - team communication.
- **Google Meet** - weekly team meetings.

---

## Technical Stack

### Stack Overview

| Layer | Technology |
| :--- | :--- |
| Frontend | React 18 + Vite + TypeScript |
| Backend | NestJS 10 (Express platform) + TypeScript |
| Validation | class-validator / class-transformer |
| Database | PostgreSQL 16 + Prisma 5 (committed SQL migrations) |
| Authentication | Argon2id password hashing + hashed cookie sessions |
| Real-time | Socket.IO |
| Chess engine | chess.js |
| Infrastructure | Docker + Docker Compose, Nginx (TLS termination & reverse proxy) |
| Version control | Git / GitHub |

### Why These Technologies?
- _TODO: ._

---

# Database Design

Four data modules (full contract in [docs/database-setup.md](docs/database-setup.md)):

- **users** - accounts, ELO `rating`, role, status, Argon2id password hash.
- **sessions** - hashed bearer tokens with expiry (cascade-deleted with the user).
- **games** - match records (players, result, ratings and rating changes, PGN, timing).
- **game_moves** - per-move history (ply, SAN/UCI, FEN, clock), unique per `(game_id, ply)`.

The DB roles are split: an owner role runs migrations and seeding, while the app connects with a restricted role that can only do CRUD.

---

# Features List

| Feature | Contributor(s) | Description |
| :--- | :--- | :--- |
| ELO rating system | astefans | Pure ELO engine (expected score + rating update, K-factor 32, rating floor) and a transactional, idempotent service that updates both players' ratings when a game ends. |
| Player waiting queue | astefans | In-memory queue; one entry per authenticated user, holding their rating and chosen time control. |
| Automated opponent matching | astefans | Pairs the closest-rated waiting players within a tolerance that widens the longer they wait; creates the game (RAM session + `IN_PROGRESS` row) and notifies both clients over Socket.IO. |
| Ranking & statistics API | astefans, pmamala, tszymans | Per-user profile and statistics (`GET /api/profile/me`), public web leaderboard (`GET /api/leaderboard`), and machine-to-machine public ranking API (`GET /api/v1/leaderboard`). |
| Public API & Match History | tszymans | Stateless REST API secured by SHA-256 API keys and sliding-window rate limiting (60 req/min). Match history queries (Issue #90), full API key CRUD, global ELO leaderboard & platform statistics (Issue #146) with OpenAPI/Swagger docs at `/api/docs`. |
| Game conclusion & rating trigger | tszymans | Authoritative termination hook in `GameService.removeGame()` resolving final results (`WHITE_WON`, `BLACK_WON`, `DRAW`, `ABORTED`), persisting to PostgreSQL `games`, and triggering atomic Elo recalculations via `RatingService.applyGameResult()`. |

---

# Modules

Point values follow the subject: **major module = 2 points**, **minor module = 1 point**.

### Web
- **Public API & Match History (Major Module — 2 Points)**:
  A stateless, machine-to-machine REST API authenticated via cryptographic `X-API-Key` headers and protected by sliding-window rate limiting. Interactive OpenAPI/Swagger documentation is served at `/api/docs`.
  - **Documentation & Architecture Contract**: [docs/public-api.md](docs/public-api.md)
  - **Interactive Swagger UI**: `https://localhost/api/docs`
  - **Pre-seeded Evaluator Key**:
    `tr_live_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef`
  - **Endpoints**:
    - Match History (Issue #90): `GET /api/v1/matches`, `GET /api/v1/matches/:id`
    - Leaderboard & Statistics (Issue #146): `GET /api/v1/leaderboard`, `GET /api/v1/leaderboard/stats`, `GET /api/v1/leaderboard/players/:username`
    - API Keys CRUD: `POST /api/v1/api-keys`, `GET /api/v1/api-keys`, `GET /api/v1/api-keys/:id`, `PUT /api/v1/api-keys/:id`, `DELETE /api/v1/api-keys/:id`
    - Web User API Keys (Session Auth): `POST /api/user/api-keys`, `GET /api/user/api-keys`, `DELETE /api/user/api-keys/:id`
    - Web Leaderboard (no auth, 60 req/min per IP): `GET /api/leaderboard`
    - Web Match History (session auth): `GET /api/profile/me/games?page=&limit=`
  - **Verification Commands**:
    ```bash
    docker compose run --rm backend npm run test:leaderboard:api
    docker compose run --rm -e TEST_DATABASE_URL='<application-role URL for chess_test>' backend npm run test:leaderboard:db
    docker compose run --rm backend npm run test:public-api
    docker compose run --rm backend npm run test:api-guard
    docker compose run --rm backend npm run test:apikey
    ```

- _TODO: list the modules the project implements, grouped by category, with a running subtotal and total._

---

# Individual Contributions

## tszymans - Product Owner
### Responsibilities
Product Owner, Public API subsystem, API key security, sliding-window rate limiting, and public statistics.

### Main Contributions
- Designed and built the machine-to-machine Public API under `/api/v1` with cryptographic API keys (`X-API-Key`), sliding-window rate limiting, and automated Swagger UI (`/api/docs`).
- Implemented match history endpoints (`GET /api/v1/matches`, `GET /api/v1/matches/:id`) with player and outcome filtering, move ordering, and UUID validation guards.
- Implemented public leaderboard and platform statistics (`GET /api/v1/leaderboard`, `GET /api/v1/leaderboard/stats`, `GET /api/v1/leaderboard/players/:username`) with win/loss aggregation and win percentage calculation.
- Connected real backend APIs to frontend ranking (`/ranking`) and history (`/history`) views, eliminating static mock data.
- Built test suites covering API security, rate limit headers, match queries, and leaderboard pagination.

### Challenges
- Guaranteeing database protection against DoS by enforcing zero-I/O key validation and sliding-window rate limiting before database queries.
- Designing consistent pagination and aggregation for player rankings while handling ties and case-insensitive lookups safely.

## pjedrycz - Tech Lead
### Responsibilities
_TODO_
### Main Contributions
_TODO_
### Challenges
_TODO_

## brogalsk - Project Manager
### Responsibilities
_TODO_
### Main Contributions
_TODO_
### Challenges
_TODO_

## astefans - Developer
### Responsibilities
Matchmaking, player ranking and game stats: the ELO system, the waiting queue, automated opponent matching, and the ranking/stats API.

### Main Contributions
- Wrote the ELO engine as a standalone, fully tested module, plus a service that applies the rating changes at the end of a game (runs in a transaction and is safe to call more than once).
- Built the matchmaking side: the waiting queue, rating-based pairing that loosens up the longer you wait, and creating the game (DB row + in-memory session), all exposed over a Socket.IO gateway that reuses the session cookie for auth.
- Added the Nginx route for Socket.IO and kept the whole thing under unit tests.

### Challenges
- Keeping the matchmaking logic independent of the transport, so I could unit-test it without a DB or sockets - the Socket.IO gateway ended up being just a thin layer on top.
- Hooking into other people's code - creating games through the engine's `GameService`, and plugging rating updates into the end-of-game flow.

## pmamala - Developer
### Responsibilities
_TODO_
### Main Contributions
_TODO_
### Challenges
_TODO_

---

# Project Structure

```
ft_transcendence/
├── frontend/              # React + Vite + TypeScript client
├── backend/               # NestJS API, WebSocket gateway and chess engine
│   ├── prisma/            # schema, migrations, seed, role init
│   └── src/
│       ├── auth/          # registration, login, sessions, guards
│       ├── database/      # Prisma service (global module)
│       ├── game/          # authoritative chess engine & state manager
│       ├── matchmaking/   # waiting queue, pairing, Socket.IO gateway
│       ├── profile/       # user profile & statistics
│       ├── public-api/    # API keys, match history, leaderboard & platform stats
│       ├── rating/        # ELO rating engine & service
│       └── health/        # health check endpoint
├── nginx/                 # TLS termination & reverse proxy
├── docs/                  # setup and implementation documentation
├── docker-compose.yml
└── Makefile
```

## Architecture
Everything runs in Docker Compose: Nginx (TLS + reverse proxy) sits in front of the React frontend and the NestJS backend, with PostgreSQL and a one-shot container that runs migrations and seeding. _TODO: link to an architecture doc._

---

# Resources

## Documentation and References
- _TODO: official documentation consulted (NestJS, Prisma, Socket.IO, etc.)._

## AI Usage
- _TODO: describe how AI tools assisted and confirm the team remained responsible for the final work._

---

# Development Documentation
_TODO: add `docs/DEVELOPMENT.md` with common commands, Prisma workflows, Docker usage and troubleshooting._

---

# License
Created for the 42 curriculum; intended for educational purposes within the context of the 42 curriculum.

## Friends backend

Friend requests, acceptance/removal, public user lookup and authenticated online
presence are implemented. Frontend integration is assigned separately. See the
[friends frontend handoff](docs/friends-frontend-handoff.md) for API contracts,
Socket.IO integration, migration instructions and tests.

### Friends deployment notes

The additive `202610270001_friends` migration runs through the migration service;
existing users and games are preserved. Configure a local, Git-ignored `.env` from
`.env.example` with matching database passwords and connection URLs before running
`docker compose up --build -d`. Required database settings now fail with a clear
message when missing; admin bootstrap settings remain optional.

Compose assigns project-specific container names, avoiding conflicts with older
checkouts using a container named `postgres`. Only one checkout can bind the default
host ports 80/443 at a time. Stop an older checkout from its folder with
`docker compose down` when necessary; do not add `-v` unless deleting its database
volume is intentional. Commit configuration changes, never the local `.env`.
