*This project has been created as part of the 42 curriculum by astefans, brogalsk, tszymans, pjedrycz and pmamala*

# ChessHub - ft_transcendence

## Description

A full-stack **chess** app you play in the browser: real-time multiplayer over WebSockets, matchmaking, ELO ranking, player stats, tournaments, a Stockfish AI opponent to practise against, and an in-game AI chat companion.

### Goal
Build a chess app with multiplayer, tournaments, a scoring/ranking system and AI.

### Features
- **Authentication & security** - registration, login, cookie sessions, CSRF checks, rate limiting (Argon2id password hashing).
- **Real-time chess gameplay** - authoritative server-side engine with move validation and turn ownership.
- **Matchmaking & ranking** - waiting queue, ELO-based automated opponent matching, player rating.
- **User profiles & statistics** - per-user profile with win/loss/draw record and recent games.
- **Public API (fully implemented), Match History & Leaderboard** - secured API keys (SHA-256), sliding-window rate limiting (60 req/min), interactive Swagger UI (`/api/docs`), match history queries, global ELO leaderboard, and platform statistics.
- **Game conclusion & ELO rating trigger** - authoritative match conclusion resolution (checkmate, stalemate, draws, resignation, timeouts), atomic PostgreSQL persistence, and automatic ELO rating updates.
- **Tournament bracket & progression engine** - automated single-elimination tournament generator with balanced seed-fold pairing, Round 1 Bye resolution, match progression to champion, and knockout draw tiebreak handling.
- **Tournament registration & lifecycle** - create, browse (open / live / past) and join tournaments; the creator or an admin can close registration early or cancel. Registration closes on its own at the deadline, the bracket starts automatically, and tournaments with fewer than 2 players are cancelled.
- **Tournament live updates** - lobby and bracket update in real time over Socket.IO (`/tournaments`): joins, start, every match change, the final result and invitations ([contract](docs/tournaments-realtime.md)).
- **Tournament invitations** - the creator or any registered player can invite friends to an open tournament; the friend accepts (joins) or declines, and can be invited again after declining.
- **Play against the computer** - a Stockfish-backed AI opponent with easy / medium / hard settings and on-demand move hints. These games show up in your match history but don't touch your ELO.
- **AI chat companion** - an LLM you can chat with mid-game that plays coach, commentator, rival or just casual, and actually knows the position you're in (it gets the live board). Your messages get a quick sentiment read, and a moderation layer (local blocklist + LLM classifier) keeps abusive stuff out.
- **Friends and player chat** - friend requests, acceptance/removal, public profiles and online presence; authenticated in-game messages between opponents.
- **Tournament UI** - creation, invitations, registration, live brackets, check-in, matches and final standings.
- **Account settings** - username and password changes.
- **Restart recovery** - casual and active tournament games resume from committed moves under the same game ID.

---

# Instructions

## Prerequisites
- A container engine: **Docker** (with the **Docker Compose v2** plugin, i.e. `docker compose`)
- **GNU Make**
- Internet access for the first build (container images, npm packages and system packages).
- Free host ports 80/443, or explicitly configured alternatives.

Node, PostgreSQL, Stockfish and OpenSSL are installed inside the containers; they are not required on the host for Docker deployment.

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

## Database URLs and first startup

`DATABASE_URL` uses the restricted application account; `MIGRATION_DATABASE_URL`
uses the owner account. Inside Compose both use hostname `postgres`, port `5432`
and the database named by `POSTGRES_DB`:

```dotenv
DATABASE_URL=postgresql://chess_app:YOUR_APP_PASSWORD@postgres:5432/chess
MIGRATION_DATABASE_URL=postgresql://chess_owner:YOUR_OWNER_PASSWORD@postgres:5432/chess
```

Replace the examples, keeping credentials consistent with `APP_DB_USER`,
`APP_DB_PASSWORD`, `POSTGRES_USER` and `POSTGRES_PASSWORD`. URL-encode special
characters in URL passwords. Keep `ADMIN_PASSWORD` empty unless bootstrapping an
admin; configure all admin fields consistently when enabling it.

```bash
make detached
# Equivalent startup: docker compose up --build -d
docker compose ps -a
docker compose logs --tail=100 migration backend nginx
```

The migration service should exit successfully (code 0); it is not a long-running
server. Open `https://localhost`, register two accounts with distinct emails and
use two browser profiles to test interaction. `/api/health` checks HTTP availability;
it does not prove every database or AI feature works. `/api/docs` exposes Swagger.

Changing database passwords in `.env` does not change credentials in an existing
PostgreSQL volume. Coordinate a role-password update rather than deleting real data.
Only one checkout can use a given set of host ports.

## School local-network testing

On the host, for example `10.12.5.2`, set:

```dotenv
APP_ORIGIN=https://10.12.5.2:8443
```


Every client, including the host's browser, must use server IP address, for example: `https://10.12.5.2:8443`.
The origin includes the port and has no path/trailing slash. A shell-exported
`APP_ORIGIN` overrides `.env`; unset it if it contains an old value. The LAN must
permit connections to that port. No additional PostgreSQL port exposure is needed.

The supplied development certificate covers localhost/127.0.0.1 only. For LAN
HTTPS, generate a certificate containing the actual host IP in its subjectAltName
and trust its issuing certificate on the test computers. Rebuild Nginx after
changing certificate generation. Use the explicit HTTPS URL: the current HTTP
redirect does not preserve a custom external port such as 8443.

For `REQUEST_ORIGIN_REJECTED`, inspect registration request headers: `Origin`
must equal the running backend's `APP_ORIGIN`, and `X-CSRF-Protection` must be `1`.
Restarting a container alone does not reload its environment; recreate it.

## Optional AI configuration

Set `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` and `LLM_TIMEOUT_MS` in `.env` and
recreate the backend. Use a Gemini model available to your own project/account;
a checked-in example model name is not proof of availability. Never put provider
keys in frontend code. Without a key, human games and Stockfish can still operate,
but LLM chat is unavailable. Stockfish is installed in the backend image.

## Testing

These are commands to run, not a claim that every test passes in every checkout:

```bash
# Authentication/account tests (also builds the backend)
docker compose exec backend npm test
# Module suites are separate from npm test
docker compose exec backend npm run test:game-recovery
docker compose exec backend npm run test:tournament-recovery
docker compose exec backend npm run test:tournament-games
docker compose exec backend npm run test:game-moves
docker compose exec backend npm run test:public-api
docker compose exec backend npm run test:chat
# Verify the frontend TypeScript/production build too
docker compose exec frontend npm run build
```

For database integration tests, provision and migrate a **separate** database with
a name ending in `_test` and use its application-role URL via `TEST_DATABASE_URL`.
See [database setup](docs/database-setup.md) and [auth testing](docs/auth-testing.md).
Integration tests create/delete fixtures; never point them at the team's real data.

Manual acceptance: two computers register/login; send and accept a friend request;
play and chat; reconnect; inspect final history/ELO; complete a tournament; test
API-key CRUD/limits; demonstrate AI. During a tournament, stop/start Docker without
removing volumes and verify the same saved game resumes and advances the bracket
once. Check responsive layouts, public legal pages and the Chrome console.

## Stop and data preservation

```bash
docker compose down
```

This preserves the named database volume. **`make clean`, `make fclean`, `make re`
and `docker compose down -v` delete database data** in this project's Makefile.
Use ordinary `down` and `up --build` for restart testing.

---

# Team Information

## Team

| Member | Role | Main Responsibilities |
|--------|------|-----------------------|
| tszymans | Product Owner | Public API, tournament lifecycle/recovery, account settings and database ownership/documentation. |
| pjedrycz | Tech Lead | Architecture/integration reviews, authentication, friends backend, player-chat backend, legal documentation and tournament restart fixes. |
| brogalsk | Project Manager | Organizing and tracking team tasks and progress; chess engine ownership. |
| astefans | Developer | Matchmaking, ELO ranking and game statistics, plus the AI side: the Stockfish opponent and the LLM chat companion (sentiment + moderation). |
| pmamala | Main Frontend Developer | Frontend implementation, UI integration and responsive layouts. |

### Git aliases and subsystem ownership

| School login | Git alias |
| --- | --- |
| tszymans | tszyman |
| pjedrycz | drwyspa |
| brogalsk | bartek3058 |
| astefans | Alaxea |
| pmamala | piomam21 |

| Subsystem | Owner(s) |
| --- | --- |
| Chess engine | brogalsk |
| Database | tszymans |
| Infrastructure | pjedrycz, astefans |
| Frontend | pmamala |

Ownership identifies the lead for a subsystem; individual shared contributions
are described below.

## Project Management
- **GitHub Issues & Projects** - task tracking and board.
- **Feature-branch Git workflow** - one feature per pull request, reviewed before merge to `main`.
- **GitHub Kanban dashboard** - progress tasks tracking.
- **Slack** - team communication.
- **Google Meet** - bi-weekly team meetings.

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
- **TypeScript across frontend and backend** reduces language switching and makes API contracts easier to maintain under a short deadline.
- **React and NestJS** provide component-based UI and a modular backend with dependency injection, validation and WebSocket support.
- **PostgreSQL** provides relational constraints and transactions for users, games, ratings and tournament state.
- **Prisma** supplies typed database access and versioned migrations; SQL is used where explicit locking or atomic updates are needed.
- **Socket.IO** provides bidirectional events and reconnection support; the backend remains authoritative for moves and clocks.
- **chess.js** implements chess rules; **Stockfish** supplies the computer opponent through UCI. These have distinct roles.
- **Docker Compose and Nginx** provide a repeatable local deployment and a single HTTPS entry point.

These reasons describe how the current stack fits the project. The team should confirm they reflect its original decisions.

---

# Database Design

Database setup and roles (full contract in [docs/database-setup.md](docs/database-setup.md)):

- **users** - accounts, ELO `rating`, role, status, Argon2id password hash.
- **sessions** - hashed bearer tokens with expiry (cascade-deleted with the user).
- **games** - match records (players, result, ratings and rating changes, PGN, timing).
- **game_moves** - per-move history (ply, SAN/UCI, FEN, clock), unique per `(game_id, ply)`.

Additional tables:

- **friendships** - requester, two user references, relationship status and timestamps.
- **api_keys** - user owner, hashed key, prefix, expiration/revocation and usage metadata.
- **tournaments** - creator, title, status, capacity, registration deadline and champion.
- **tournament_participants** - tournament/user links, seeds, check-in-independent registration and final rank.
- **tournament_matches** - bracket round/position, players, winner, next-match link and check-in state.
- **tournament_invitations** - tournament, sender, recipient, response and timestamps.

UUID primary/foreign keys connect these tables. Games link to users and optionally
tournament matches; each game has ordered moves unique by `(game_id, ply)`.
The schema diagram below includes field types and the remaining relationships.

The DB roles are split: an owner role runs migrations and seeding, while the app connects with a restricted role that can only do CRUD.

Full diagram of all 10 tables and their relations (Mermaid, renders on GitHub): [docs/database-schema.md](docs/database-schema.md).

---

# Features List

| Feature | Contributor(s) | Description |
| :--- | :--- | :--- |
| Infrastructure | pjedrycz, astefans | Docker Compose deployment, Nginx HTTPS/proxy configuration and service integration. |
| Authentication | pjedrycz | Registration, login, password hashing, cookie sessions, validation and request guards. |
| Friends | pjedrycz (backend), pmamala (frontend) | Requests, acceptance/removal, public profiles and online presence with browser integration. |
| Player chat | pjedrycz (backend), pmamala (frontend) | Opponents exchange messages through authenticated game rooms; recent history is held in server RAM. |
| Chess engine and gameplay | brogalsk (engine), pmamala (frontend) | Server-side move validation, clocks, game state and persistence. |
| Tournament frontend | pmamala (frontend), tszymans (backend)| Create/join, invitations, bracket display, check-in and game navigation. |
| Legal pages | pjedrycz | Public privacy policy and terms pages and operator documentation. |
| Database foundation | tszymans | PostgreSQL roles, constraints, schema and migrations. |
| ELO rating system | astefans | Pure ELO engine (expected score + rating update, K-factor 32, rating floor) and a transactional, idempotent service that updates both players' ratings when a game ends. |
| Player waiting queue | astefans | In-memory queue; one entry per authenticated user, holding their rating and chosen time control. |
| Automated opponent matching | astefans | Pairs the closest-rated waiting players within a tolerance that widens the longer they wait; creates the game (RAM session + `IN_PROGRESS` row) and notifies both clients over Socket.IO. |
| Ranking & statistics API | astefans, pmamala, tszymans | Per-user profile and statistics (`GET /api/profile/me`), public web leaderboard (`GET /api/leaderboard`), and machine-to-machine public ranking API (`GET /api/v1/leaderboard`). |
| Public API & Match History | tszymans | Stateless REST API secured by SHA-256 API keys and sliding-window rate limiting (60 req/min). Match history queries (Issue #90), full API key CRUD, global ELO leaderboard & platform statistics (Issue #146) with OpenAPI/Swagger docs at `/api/docs`. |
| Game conclusion & rating trigger | tszymans | Authoritative termination hook in `GameService.removeGame()` resolving final results (`WHITE_WON`, `BLACK_WON`, `DRAW`, `ABORTED`), persisting to PostgreSQL `games`, and triggering atomic Elo recalculations via `RatingService.applyGameResult()`. |
| Tournament registration & lifecycle | tszymans | Session-authenticated REST routes under `/api/tournaments` (create, list, detail, join, leave, close-registration, cancel). Atomic slot counting in PostgreSQL, a 60 s deadline scheduler that starts the bracket exactly once, frozen seed ratings in responses. Contract: [docs/tournaments-api.md](docs/tournaments-api.md). |
| AI opponent (Stockfish) | astefans | Human-vs-AI chess over Socket.IO, backed by a real Stockfish engine (UCI). Three difficulties driven by Stockfish's own Skill Level (easy / medium / hard), full-strength move hints, and a seeded `stockfish` bot user so AI games appear in match history while staying out of the ELO system. |
| AI chat, sentiment & moderation | astefans | `POST /api/ai/chat`: an LLM chat companion in four personas (coach / commentator / rival / casual) that gets the live game context (FEN + moves). A local lexicon tags each message's sentiment (words + emoji), and moderation (deterministic blocklist + LLM classifier) can block input before the conversational reply; classification itself may send input to the provider. |
| Live game restart recovery | tszymans, pjedrycz | After a backend restart, casual and active tournament games are rebuilt from saved moves and players rejoin at the same position with the same clocks; interrupted AI games are aborted (unrated). Details: [docs/game-restart-recovery.md](docs/game-restart-recovery.md). |
| ELO progression API | tszymans | Backend rating history intended for a profile chart (`GET /api/profile/me/rating-history`), built from the frozen per-game rating snapshots, so past points never change when the live rating does. |
| Account settings | tszymans | Change your username (case is kept, uniqueness ignores case) or password from a logged-in session; a password change signs out every other device. Details: [docs/account-settings.md](docs/account-settings.md). |

---

# Modules

An overview of the modules built for the 42 ft_transcendence project, covering their point values, the people behind each one, and how they were implemented.

Point values follow the subject: **major module = 2 points**, **minor module = 1 point**.

## Web

| Module | Type | Points | Contributor(s) | Implementation |
|---|---|---:|---|---|
| Use a framework for both the frontend and backend | Major | 2 | pjedrycz (backend), pmamala, astefans (frontend) | NestJS 10 backend and React 18 + Vite frontend, both in TypeScript |
| Implement real-time features using WebSockets or similar technology | Major | 2 | All | Socket.IO gateways for live gameplay and matchmaking, player chat and tournament updates |
| Allow users to interact with other users | Major | 2 | pjedrycz (backend), pmamala (frontend) | Friends (requests, acceptance/removal, presence) and authenticated in-game player chat |
| A public API to interact with the database with a secured API key, rate limiting, documentation, and at least 5 endpoints: GET, POST, PUT, DELETE | Major | 2 | tszymans, pmamala | Stateless `/api/v1` with SHA-256 API keys, sliding-window rate limiting, Swagger docs and 5+ CRUD endpoints |
| Use an ORM for the database | Minor | 1 | tszymans | Prisma with PostgreSQL |

**Web subtotal: 9 points**

## Accessibility and Internationalization

| Module | Type | Points | Contributor(s) | Implementation |
|---|---|---:|---|---|
| Support for additional browsers | Minor | 1 | All | Compatibility testing across modern browsers |

**Accessibility & Internationalization subtotal: 1 points**

## User Management

| Module | Type | Points | Contributor(s) | Implementation |
|---|---|---:|---|---|
| Game statistics and match history (requires a game module) | Minor | 1 | astefans, tszymans, pmamala | Per-user profile with win/loss/draw record, recent games and ELO history |

**User Management subtotal: 1 points**

## Artificial Intelligence

| Module | Type | Points | Contributor(s) | Implementation |
|---|---|---:|---|---|
| Introduce an AI Opponent for games | Major | 2 | astefans | Stockfish opponent over Socket.IO with easy/medium/hard and move hints; seeded bot user kept out of ELO |
| Content moderation AI | Minor | 1 | astefans | Deterministic blocklist plus an LLM classifier that blocks flagged chat before the reply |
| Sentiment analysis for user-generated content | Minor | 1 | astefans | Local lexicon tags each message's mood (words + emoji, handles negation/intensifiers) |

**Artificial Intelligence subtotal: 4 points**

## Gaming and user experience

| Module | Type | Points | Contributor(s) | Implementation |
|---|---|---:|---|---|
| Implement a complete web-based game where users can play against each other | Major | 2 | brogalsk (engine), pmamala (frontend) | Authoritative server-side chess (chess.js) with move validation, clocks and persistence |
| Remote players | Major | 2 | brogalsk, pmamala | Two networked players matched and kept in sync in real time over Socket.IO |
| Implement a tournament system | Minor | 1 | tszymans (backend), pmamala (frontend) | Single-elimination brackets, registration/lifecycle, invitations and live updates |

**Gaming and user experience subtotal: 5 points**

## Total

| Category | Points |
|---|---:|
| Web | 9 |
| Accessibility & Internationalization | 1 |
| User Management | 1 |
| Artificial Intelligence | 4 |
| Gaming and user experience | 5 |
| **Total** | **20** |


# Individual Contributions

## tszymans - Product Owner
### Responsibilities
Public API subsystem, API key security, sliding-window rate limiting, and public statistics.

### Main Contributions
- Designed and built the machine-to-machine Public API under `/api/v1` with cryptographic API keys (`X-API-Key`), sliding-window rate limiting, and automated Swagger UI (`/api/docs`).
- Implemented match history endpoints (`GET /api/v1/matches`, `GET /api/v1/matches/:id`) with player and outcome filtering, move ordering, and UUID validation guards.
- Implemented public leaderboard and platform statistics (`GET /api/v1/leaderboard`, `GET /api/v1/leaderboard/stats`, `GET /api/v1/leaderboard/players/:username`) with win/loss aggregation and win percentage calculation.
- Connected real backend APIs to frontend ranking (`/ranking`) and history (`/history`) views, eliminating static mock data.
- Built test suites covering API security, rate limit headers, match queries, and leaderboard pagination.
- Built tournament registration and lifecycle (Issue #102): seven `/api/tournaments` routes, a registration-deadline scheduler, and start/cancel transitions that stay consistent under concurrent requests, all tested against real PostgreSQL.
- Made live games survive a backend restart (Issue #76): casual games are restored from move history on startup, AI games are cleanly aborted, and corrupt histories are aborted instead of crashing the boot.
- Added the ELO progression endpoint for the profile chart, read from frozen per game rating snapshots.
- Added account settings: username change with mixed-case names and case-insensitive uniqueness, and password change that rotates every session in one transaction.
- Allowed mixed-case usernames at registration, matching rename, the API and the DB check, with uniqueness still ignoring case.

### Challenges
- Guaranteeing database protection against DoS by enforcing zero-I/O key validation and sliding-window rate limiting before database queries.
- Designing consistent pagination and aggregation for player rankings while handling ties and case-insensitive lookups safely.
- Making joins, closes, cancels and the scheduler safe to race each other: every state change is one conditional `UPDATE` on the tournament row, so exactly one outcome commits.

## pjedrycz - Tech Lead
### Responsibilities
Architecture and integration coordination, backend authentication/friends work,
code review and evaluation preparation.
### Main Contributions
- Implemented and integrated registration/login, input validation and secure session handling.
- Built the friends backend and frontend handoff documentation.
- Implemented the player-chat backend and worked on integration/testing.
- Prepared privacy/terms pages and operator documentation.
- Extended restart recovery to active tournament games and corrected stale-board handling.
### Challenges
Keeping authentication and database contracts consistent across teammates' branches;
resolving deployment/origin configuration issues; preserving game identity and
bracket consistency across restarts. Confirm this summary before submission.

## brogalsk - Project Manager
### Responsibilities
Organizing the team's work, assigning and tracking tasks, and monitoring each
member's progress. Technical owner of the chess engine.
### Main Contributions
- Coordinated task planning and tracked implementation progress across the team.
- Implemented the chess engine subsystem, including authoritative gameplay logic.
- Contributed player information to the game data used by the frontend.
### Challenges
The main challenge was developing the chess game engine. The implemented
subsystem provides authoritative server-side gameplay and move validation.
For the final submission, add one specific difficulty encountered and how it
was resolved; the topic alone does not describe the solution.

## astefans - Developer
### Responsibilities
Matchmaking, player ranking and game stats: the ELO system, the waiting queue, automated opponent matching, and the ranking/stats API. Plus the AI side of the app: the Stockfish opponent and the LLM chat companion (sentiment + moderation included).

### Main Contributions
- Wrote the ELO engine as a standalone, fully tested module, plus a service that applies the rating changes at the end of a game (runs in a transaction and is safe to call more than once).
- Built the matchmaking side: the waiting queue, rating-based pairing that loosens up the longer you wait, and creating the game (DB row + in-memory session), all exposed over a Socket.IO gateway that reuses the session cookie for auth.
- Added the Nginx route for Socket.IO and kept the whole thing under unit tests.
- Wired up a Stockfish AI opponent you can actually play against: three difficulty levels (I lean on Stockfish's own Skill Level, so "easy" genuinely blunders instead of just thinking shallowly), full-strength move hints, and a seeded bot user so those games land in match history without messing with anyone's ELO.
- Built the AI chat: an LLM companion with a handful of personas that knows the position you're playing, a small local sentiment analyzer that tags the mood of your messages (handles emoji and "very"/"not" too), and a moderation layer - a deterministic blocklist backed by an LLM classifier - that blocks flagged messages before conversational generation; the classifier may itself use the model.

### Challenges
- Keeping the matchmaking logic independent of the transport, so I could unit-test it without a DB or sockets - the Socket.IO gateway ended up being just a thin layer on top.
- Hooking into other people's code - creating games through the engine's `GameService`, and plugging rating updates into the end-of-game flow.
- Fitting the AI opponent into the normal game flow: it's a real user row so games reference it like any other player, but the rating service has to recognise the bot and leave those results out of ELO.

## pmamala - Main Frontend Developer
### Responsibilities
Main frontend developer, responsible for the React UI and integration with backend
APIs and WebSocket events.
### Main Contributions
- Built and integrated tournament screens, invitations, brackets, games and standings.
- Integrated friends and in-game player chat interfaces.
- Added account editing, player names/ratings and game-result displays.
- Improved responsive navigation, game layouts and AI-game presentation.
### Challenges
The main challenge was eliminating browser-console errors across the frontend.
This work focused on identifying and correcting errors during browser testing.
For the final submission, add one concrete error and its fix; record the final
console verification result with the browser/version used.

---

# Project Structure

```
ft_transcendence/
├── frontend/              # React + Vite + TypeScript client
├── backend/               # NestJS API, WebSocket gateway and chess engine
│   ├── prisma/            # schema, migrations, seed, role init
│   └── src/
│       ├── ai/            # Stockfish opponent and AI game gateway
│       ├── chat/          # LLM conversation, moderation and sentiment
│       ├── friends/       # friendships and online presence
│       ├── auth/          # registration, login, sessions, guards
│       ├── database/      # Prisma service (global module)
│       ├── game/          # authoritative chess engine & state manager
│       ├── matchmaking/   # waiting queue, pairing, Socket.IO gateway
│       ├── profile/       # user profile & statistics
│       ├── public-api/    # API keys, match history, leaderboard & platform stats
│       ├── rating/        # ELO rating engine & service
│       ├── tournament/    # bracket engine, registration routes, lifecycle & deadline scheduler
│       └── health/        # health check endpoint
├── nginx/                 # TLS termination & reverse proxy
├── docs/                  # setup and implementation documentation
├── docker-compose.yml
└── Makefile
```

## Architecture
Nginx terminates HTTPS and proxies browser requests to the React frontend,
NestJS REST API and Socket.IO gateways. Only Nginx publishes host ports. A
one-shot migration service applies migrations/seeding before the backend starts.
The application uses a restricted DB role; migrations use the owner role.

```mermaid
flowchart LR
    Browser[Browser] -->|HTTPS / WSS| Nginx[Nginx]
    Nginx --> Frontend[React / Vite]
    Nginx --> Backend[NestJS REST / Socket.IO]
    Backend --> DB[(PostgreSQL)]
    Migration[Migration and seed service] --> DB
    Backend --> Stockfish[Stockfish UCI process]
    Backend -->|HTTPS, optional| Gemini[Gemini API]
```

Game sessions and clocks run in backend memory; moves and final results are
persisted through Prisma. Restart recovery reconstructs eligible human games
from committed moves. Tournament result reconciliation handles missed bracket
updates. This implementation assumes one backend instance.

The Docker services currently use development servers, not a production-hardened
hosting setup. See [restart recovery](docs/game-restart-recovery.md) and
[move persistence](docs/move-history-persistence.md).

---

# Resources

## Documentation and References
Primary references for the technologies used (each contributor should confirm
which references they consulted):

- [TypeScript handbook](https://www.typescriptlang.org/docs/handbook/intro.html)
- [React documentation](https://react.dev/learn)
- [NestJS documentation](https://docs.nestjs.com/)
- [Prisma documentation](https://www.prisma.io/docs)
- [PostgreSQL 16 documentation](https://www.postgresql.org/docs/16/)
- [Socket.IO documentation](https://socket.io/docs/v4/)
- [Docker Compose documentation](https://docs.docker.com/compose/)
- [Nginx documentation](https://nginx.org/en/docs/)
- [chess.js documentation](https://github.com/jhlywa/chess.js)
- [Stockfish documentation](https://official-stockfish.github.io/docs/stockfish-wiki/Home.html)
- [Gemini API documentation](https://ai.google.dev/gemini-api/docs)

## AI Usage
AI coding assistance was used for architecture discussion, authentication and
friends implementation/integration, troubleshooting Docker/origin configuration,
code reviews, tests, tournament restart recovery, and drafting documentation,
including this README and the legal pages. These activities include the work
coordinated by pjedrycz using Codex/ChatGPT.

This development assistance is separate from the application's runtime AI:
Stockfish chooses chess moves; the configured Gemini-compatible API generates
chat replies and classifies content; sentiment analysis is local.

The team has confirmed the contribution summaries and the documented AI usage
and verification responsibilities. The description above records the known
assisted tasks; it does not imply that every teammate used the same tool or that
every generated suggestion was independently verified by every team member.

---

# Development Documentation
- [Database setup and roles](docs/database-setup.md)
- [Database schema](docs/database-schema.md)
- [Authentication tests](docs/auth-testing.md)
- [Input contract](docs/auth-input-contract.md)
- [Friends API and socket contract](docs/friends-frontend-handoff.md)
- [Tournament API](docs/tournaments-api.md)
- [Tournament realtime events](docs/tournaments-realtime.md)
- [Public API](docs/public-api.md)
- [Account settings](docs/account-settings.md)
- [Restart recovery and regression steps](docs/game-restart-recovery.md)

---

# License
Created for the 42 curriculum; intended for educational purposes within the context of the 42 curriculum.

## Friends backend

Friend requests, acceptance/removal, public user lookup and authenticated online
presence and frontend integration are implemented. See the
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

## Privacy Policy and Terms of Service

Public `/privacy-policy` and `/terms-of-service` routes have footer and registration
links. Version 1.0 is effective 9 November 2026, naming Tomasz Szymański and
`tszymans@student.42warsaw.pl` for this locally hosted educational project.

The runtime AI provider is Google Gemini. astefans manages the AI configuration
and operational retention/deletion work. Tomasz Szymański remains the named
operator and contact in the legal documents. The exact deployed model identifier
and API service/account configuration should be recorded before evaluation.

The policy includes cleanup within 30 days after final evaluation, seven-day logs
and backups, manual deletion requests, and separate Gemini processing. These are
operator commitments; this change does not implement automated cleanup.

Read [Privacy Policy](docs/legal/privacy.md), [Terms](docs/legal/terms.md),
[data inventory](docs/legal/data-inventory.md) and the
[operator checklist](docs/legal/review-checklist.md). Confirm the Gemini API service
and applicable provider/transfer arrangements before enabling AI. Keep Markdown
copies aligned with `frontend/src/content/legal/` when updating the documents.


## Planned improvements

The following items are planned enhancements, not claims of completed features
or additional evaluation points:

- **Position advantage bar** - show whether White or Black has the advantage.
  Keep engine-assisted evaluation in analysis, spectator or AI modes to avoid
  providing assistance during competitive human matches.
- **Email invitations** - send invitations by email with links to the relevant
  tournament or invitation page.
- **Avatars** - let users upload, change and remove a profile avatar, with a
  default avatar and validation of uploaded files.
- **Achievements** - award and display persistent milestones with clear rules.
- **Progression bar** - show progress toward the next level or milestone, with
  clearly defined progression rules.
- **Captured pieces display** - show the pieces each side has lost during a game.
