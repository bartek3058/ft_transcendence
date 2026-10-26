*This project has been created as part of the 42 curriculum by astefans, brogalsk, tszymans, pjedrycz and pmamala*

# ft_transcendence

## Description

A real-time, full-stack **chess** application: multiplayer matches over WebSockets, matchmaking, an ELO ranking system, player statistics, and (planned) tournaments and AI opponents.

### Goal
The purpose of this project is to create a chess application including multiuser/multiplayer mode, tournament options, scoring system and AI integration.

### Features
- **Authentication & security** — registration, login, cookie sessions, CSRF checks, rate limiting (Argon2id password hashing).
- **Real-time chess gameplay** — authoritative server-side engine with move validation and turn ownership.
- **Matchmaking & ranking** — waiting queue, ELO-based automated opponent matching, player rating.
- **User profiles & statistics** — per-user profile with win/loss/draw record and recent games.
- _TODO: tournaments, AI opponent, live chat, internationalization._

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
Nginx terminates TLS with a self-signed certificate generated at build time and reverse-proxies the frontend, the REST API and the Socket.IO connection. The app is served at `https://localhost` (HTTP on port 80 redirects to HTTPS).

---

# Team Information

## Team

| Member | Role | Main Responsibilities |
|--------|------|-----------------------|
| tszymans | Product Owner | _TODO_ |
| pjedrycz | Project Manager | _TODO_ |
| brogalsk | Tech Lead | _TODO_ |
| astefans | Developer | Matchmaking, ELO ranking and game statistics |
| pmamala | Developer | _TODO_ |

## Project Management
- **GitHub Issues & Projects** — task tracking and board.
- **Feature-branch Git workflow** — one feature per pull request, reviewed before merge to `main`.
- _TODO: other tools (communication, documentation)._

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
- _TODO: short justification per major choice (NestJS, Prisma, PostgreSQL, Socket.IO, Docker...)._

---

# Database Design

Four data modules (full contract in [docs/database-setup.md](docs/database-setup.md)):

- **users** — accounts, ELO `rating`, role, status, Argon2id password hash.
- **sessions** — hashed bearer tokens with expiry (cascade-deleted with the user).
- **games** — match records (players, result, ratings and rating changes, PGN, timing).
- **game_moves** — per-move history (ply, SAN/UCI, FEN, clock), unique per `(game_id, ply)`.

Database roles are separated: a migration/owner role runs DDL and seeding; a restricted application role handles runtime CRUD only.

---

# Features List

| Feature | Contributor(s) | Description |
| :--- | :--- | :--- |
| ELO rating system | astefans | Pure ELO engine (expected score + rating update, K-factor 32, rating floor) and a transactional, idempotent service that updates both players' ratings when a game ends. |
| Player waiting queue | astefans | In-memory queue; one entry per authenticated user, holding their rating and chosen time control. |
| Automated opponent matching | astefans | Pairs the closest-rated waiting players within a tolerance that widens the longer they wait; creates the game (RAM session + `IN_PROGRESS` row) and notifies both clients over Socket.IO. |
| Ranking & statistics API | astefans, pmamala | Per-user profile and statistics (`GET /api/profile/me`); global leaderboard by rating (planned). |

---

# Modules

Point values follow the subject: **major module = 2 points**, **minor module = 1 point**.

- _TODO: list the modules the project implements, grouped by category, with a running subtotal and total._

---

# Individual Contributions

## tszymans — Product Owner
### Responsibilities
_TODO_
### Main Contributions
_TODO_
### Challenges
_TODO_

## pjedrycz — Project Manager
### Responsibilities
_TODO_
### Main Contributions
_TODO_
### Challenges
_TODO_

## brogalsk — Tech Lead
### Responsibilities
_TODO_
### Main Contributions
_TODO_
### Challenges
_TODO_

## astefans — Developer
### Responsibilities
Matchmaking, player ranking and game statistics: ELO rating system, waiting queue, automated opponent matching, and the ranking/statistics API.

### Main Contributions
- Implemented the ELO rating engine as a pure, fully unit-tested module, plus a transactional, idempotent `RatingService` that applies rating changes at game end.
- Built the matchmaking subsystem: in-memory queue, rating-based pairing with a time-widening tolerance window, and game creation (DB `IN_PROGRESS` row + in-memory session), exposed over a Socket.IO gateway authenticated with the session cookie.
- Added the Nginx WebSocket route for Socket.IO and kept the whole feature covered by unit tests.

### Challenges
- Keeping matchmaking logic transport-agnostic so it could be unit-tested without a database or sockets, with the Socket.IO gateway as a thin layer on top.
- Coordinating integration seams across teammates' work — creating the game through the engine's `GameService`, and wiring rating recalculation into the game-over lifecycle.

## pmamala — Developer
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
│       ├── rating/        # ELO rating engine & service
│       └── health/        # health check endpoint
├── nginx/                 # TLS termination & reverse proxy
├── docs/                  # setup and implementation documentation
├── docker-compose.yml
└── Makefile
```

## Architecture
A containerized stack orchestrated by Docker Compose: Nginx (TLS, reverse proxy) in front of the React frontend and the NestJS backend, with PostgreSQL and a one-shot migration/seed container. _TODO: link to an architecture document if added._

---

# Resources

## Documentation and References
- [Database setup and verification](docs/database-setup.md)
- [Registration and login testing](docs/auth-testing.md)
- [Database teammate handoff](docs/auth-database-handoff.md)
- [Authentication input and API contract](docs/auth-input-contract.md)
- [Stage 1 implementation guide](docs/auth-stage-one.md)
- [Stage 2 implementation guide](docs/auth-stage-two.md)
- _TODO: official documentation consulted (NestJS, Prisma, Socket.IO, etc.)._

## AI Usage
- _TODO: describe how AI tools assisted and confirm the team remained responsible for the final work._

---

# Development Documentation
_TODO: add `docs/DEVELOPMENT.md` with common commands, Prisma workflows, Docker usage and troubleshooting._

---

# License
Created for the 42 curriculum; intended for educational purposes within the context of the 42 curriculum.
