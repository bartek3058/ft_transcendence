*This project has been created as part of the 42 curriculum by astefans, brogalsk, tszymans, pjedrycz and pmamala*

# ft_transcendence

## Description

A full-stack **chess** app you play in the browser: real-time multiplayer over WebSockets, matchmaking, ELO ranking, player stats, and — further down the line — tournaments and an AI opponent.

### Goal
Build a chess app with multiplayer, tournaments, a scoring/ranking system and AI.

### Features
- **Auth & security** - registration, login, cookie sessions, CSRF checks and rate limiting (passwords hashed with Argon2id).
- **Real-time chess** - the server runs the actual game and checks every move, so the client can't cheat.
- **Matchmaking & ranking** - a waiting queue that pairs you with someone close to your ELO.
- **Profiles & stats** - each player's win/loss/draw record and recent games.
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
| ELO rating system | astefans | A small, dependency-free ELO engine (expected score + rating update, K-factor 32, with a rating floor) and a service that writes the new ratings when a game ends - in one transaction, and safe to call twice. |
| Player waiting queue | astefans | In-memory queue, one spot per logged-in player, holding their rating and chosen time control. |
| Automated opponent matching | astefans | Pairs the closest-rated players waiting, widening the allowed gap the longer you wait, then spins up the game (in-memory session + `IN_PROGRESS` row) and tells both players over Socket.IO. |
| Ranking & statistics API | astefans, pmamala | Per-player profile and stats (`GET /api/profile/me`) plus a global leaderboard by rating (`GET /api/leaderboard`). |

---

# Modules

Point values follow the subject: **major module = 2 points**, **minor module = 1 point**.

- _TODO: list the modules the project implements, grouped by category, with a running subtotal and total._

---

# Individual Contributions

## tszymans - Product Owner
### Responsibilities
_TODO_
### Main Contributions
_TODO_
### Challenges
_TODO_

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
