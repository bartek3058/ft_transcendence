# Tournament Bracket & Progression Engine

- **Module Classification:** 42 Transcendence — IV.6 Gaming and user experience, Minor: Tournament System (1 Point)
- **Author:** Tomasz Szymański (`tszymans`)
- **Status:** Implemented & Verified in Draft PR #160 (`tszyman/issue68-tournament-bracket-engine`)

---

## 1. Overview & Architecture

The Tournament Bracket Engine is responsible for the competitive lifecycle of single-elimination knockout tournaments in `ft_transcendence`. 
It provides:
1. **Pure Mathematical Topology & Seeding (`bracket-generator.ts`)**: Decoupled, zero-I/O bracket calculations for powers of 2 ($2, 4, 8, 16, 32$).
2. **Balanced Seed-Fold Matching**: Prevents top seeds from meeting until the final stages (Seed 1 and Seed 2 can only meet in the Grand Final).
3. **Automatic Round 1 Bye Resolution**: When participant count $N < \text{bracketSize}$, missing slots are assigned as Byes to top seeds and auto-advanced to Round 2.
4. **Database-Integrated Progression Service (`TournamentBracketService`)**: Executes match progressions, crowns champions, assigns final rankings, and manages knockout draw replays inside PostgreSQL transactions.

```mermaid
flowchart TD
    Participants["Registered Participants (N)"] --> Seeder["seedParticipants() (Ranked by ELO snapshot)"]
    Seeder --> Generator["generateBracket(bracketSize = nextPow2(N))"]
    Generator --> Nodes["Knockout Tree Nodes (R1 ... R_final)"]
    Nodes --> ByeCheck{"Any Bye slots?"}
    ByeCheck -- Yes --> AutoAdvance["Auto-advance Bye winners directly to R2"]
    ByeCheck -- No --> ActiveMatches["Schedule R1 Matches"]
    AutoAdvance --> ActiveMatches
    ActiveMatches --> Play["Live Chess Games"]
    Play --> ResultCheck{"Result?"}
    ResultCheck -- Decisive Win --> Advance["advanceWinner() -> Feeds nextMatch parent slot"]
    ResultCheck -- Draw (< 3) --> Replay["Replay match with swapped colors"]
    ResultCheck -- Draw (>= 3) --> SeedFallback["Tiebreak fallback: Higher seed advances"]
    Replay --> Play
    SeedFallback --> Advance
    Advance --> FinalCheck{"Grand Final?"}
    FinalCheck -- Yes --> Crown["Crown Champion & Set Final Ranks (1, 2, 3)"]
    FinalCheck -- No --> ActiveMatches
```

> Registration, deadline scheduling and the HTTP routes that start a bracket are documented in [tournaments-api.md](tournaments-api.md).

---

## 2. Seeding & Bracket Topology Rules

### Balanced Seed Folding Algorithm
For any round with $K$ matches, Round 1 seeds Match $m$ ($0$-indexed) as:
- **Player 1:** Seed $m + 1$
- **Player 2:** Seed $\text{bracketSize} - m$

Between rounds, Match $i$ (top) and Match $K - 1 - i$ (bottom) feed into the next round's Match $i$:
- `topMatch.nextMatchId = targetMatch.id`, `nextMatchSlot = 'player1'`
- `bottomMatch.nextMatchId = targetMatch.id`, `nextMatchSlot = 'player2'`

### Example Topologies:
* **4-Player Bracket (2 Rounds):**
  - `R1-M1`: Seed 1 vs Seed 4 $\to$ feeds `Final.player1`
  - `R1-M2`: Seed 2 vs Seed 3 $\to$ feeds `Final.player2`
* **8-Player Bracket (3 Rounds):**
  - `R1-M1`: Seed 1 vs Seed 8 $\to$ feeds `SF1.player1`
  - `R1-M2`: Seed 2 vs Seed 7 $\to$ feeds `SF2.player1`
  - `R1-M3`: Seed 3 vs Seed 6 $\to$ feeds `SF2.player2`
  - `R1-M4`: Seed 4 vs Seed 5 $\to$ feeds `SF1.player2`
  - `SF1` (Winner 1v8 vs Winner 4v5) and `SF2` (Winner 2v7 vs Winner 3v6) feed into the Grand Final.

### Seeding & Validation Rules
- **Deterministic Seeding (`seedParticipants`):** Participants are ranked by `seedRating` descending. Ties are broken by registration timestamp (`registeredAt` ascending, with missing timestamps sorted last), followed by a locale-independent direct comparison on `userId`.
- **Bracket Size Validation & Error Handling:** `generateBracket()` validates participant counts and bracket dimensions. It enforces powers of 2 ($2 \le \text{bracketSize} \le 32$) and rejects oversized brackets where $N \le \text{bracketSize} / 2$ so that no Round 1 matches are left without players. All input violations throw `BracketGenerationError`, which `TournamentBracketService` maps to HTTP 400 with error code `INVALID_BRACKET`, rolling back any status change.

### Automatic Round 1 Bye Handling
When $N < \text{bracketSize}$ (e.g. 6 players in an 8-slot bracket):
- Seeds 7 and 8 are absent.
- `R1-M1` (Seed 1 vs 8) and `R1-M2` (Seed 2 vs 7) are marked `isBye = true` and `status = 'COMPLETED'`.
- Seeds 1 and 2 are automatically placed into their Round 2 Semifinal slots as `player1`.
- Matches `R1-M3` (3 vs 6) and `R1-M4` (4 vs 5) remain active games (`status = 'SCHEDULED'`).

---

## 3. Match Progression & Knockout Draw Rules

### 1. `advanceWinner(tx, tournamentId, matchId, winnerId)`
- Marks current match `COMPLETED` with `winnerId`.
- Propagates `winnerId` into `nextMatchId` at `nextMatchSlot` (`player1` or `player2`).
- If the other slot in `nextMatch` is already populated, transitions `nextMatch.status = 'SCHEDULED'`.
- If concluding the Grand Final:
  - Updates tournament status to `FINISHED` and records `championId = winnerId`.
  - Sets final ranks: Champion $= 1$, Runner-up $= 2$, Semifinalists $= 3$.

### 2. Knockout Draw & Tiebreak Protocol (`handleMatchDraw`)
In a single-elimination bracket, draws cannot leave a match unresolved:
- **Draw Counting:** `handleMatchDraw` only counts concluded draws (`result: 'DRAW'`). Decisive wins, aborted matches, and abandonments are excluded. If an active game in the match is still `IN_PROGRESS`, or no drawn game exists, it rejects with HTTP 409 Conflict.
- **Games 1 & 2 Drawn:** The engine triggers an immediate rematch with piece colors swapped. The match remains `IN_PROGRESS`.
- **Game 3 Drawn (Replay Cap):** Core tiebreak fallback activates: the participant with the better seed (lower seed number) is declared the winner and advanced to the next round.
- Respects the PostgreSQL partial unique index `games_tournament_match_active_key`: allows multiple games per tournament match in history, but enforces at most one `IN_PROGRESS` game at any time.

### 3. Walkover / Forfeit Protocol (`handleWalkover`)
If a participant forfeits or fails to appear:
- The match is marked `status = 'WALKOVER'`.
- The opposing player is declared the winner and immediately advanced through the bracket.

### Double Forfeit (`handleDoubleForfeit`)
If both players are absent, both lose and nobody advances:
- The match is closed as `WALKOVER` with `winnerId = null`.
- When a next-round match can no longer get a second player (its other feeder ended in a double forfeit), it is resolved without a game: the lone player advances by `WALKOVER`; with no player left it is a double forfeit too. This cascades up to the Final.
- Double forfeit in the Final: tournament `FINISHED` with `championId = null`; both finalists get rank 2, semifinal losers rank 3.
- Sibling feeders concluding concurrently are serialized by a `SELECT ... FOR UPDATE` on the parent match.

### 4. Game Integration (`TournamentGameService` & `GameGateway`)
- **Game Conclusion Trigger (`GameGateway`):** When a move results in a board conclusion (checkmate, stalemate, threefold repetition, 50-move rule, insufficient material), `GameGateway.handleMove()` executes `concludeGame()` to invoke `removeGame()`. A shared `concludingGames` set prevents duplicate conclusions between board moves and clock timeout intervals.
- `GameService.onGameConcluded(listener)` fires exactly once per game, right after `removeGame()` wrote its result row (and the rating update ran). GameService stays tournament-agnostic; the dependency is one-way (`TournamentModule -> GameModule`).
- `TournamentGameService` registers as a listener and, for games linked to a `tournament_match_id`:
  - `WHITE_WON` / `BLACK_WON` -> `advanceWinner()`.
  - `DRAW` -> `handleMatchDraw()`; on `REPLAY` a new `games` row is created in the same transaction with colors swapped, then its in-memory session is started.
  - `ABANDONMENT` with a winner -> `handleWalkover()` for the absent player; `ABANDONMENT` without a winner -> `handleDoubleForfeit()` (no replay).
  - `ABORTED` -> bracket unchanged (logged).
  - A `409` from the bracket service means "already applied" and is logged as a no-op.
- `startMatchGame(tournamentId, matchId)` starts game 1 of a `SCHEDULED` match (player1 plays White) and moves the match to `IN_PROGRESS`. The check-in flow uses the same logic through `createMatchGame(tx, ...)` (inside the caller's transaction) and `startSession(...)` (after commit).

### 5. Match Check-in (#161)

A `SCHEDULED` match has no game until both players check in. Without check-in a no-show would leave the match `SCHEDULED` forever and block the bracket.

**Schema** (migration `20261108120000_tournament_match_check_in`) on `tournament_matches`: `check_in_deadline`, `player1_checked_in_at`, `player2_checked_in_at` (all `TIMESTAMPTZ NULL`) and an index on `(status, check_in_deadline)`. Matches that were already `SCHEDULED` get a fresh 5 minute window from the migration.

**Deadline:** set by the server whenever a match becomes `SCHEDULED`: in `generateAndSaveBracket` (Round 1, and Round 2 matches filled by Byes) and in `feedNextMatch` (progression). The window is `TOURNAMENT_CHECK_IN_WINDOW_MS = 300_000` (`tournament-rules.ts`). Draw replays stay `IN_PROGRESS` and need no new check-in.

```mermaid
flowchart TD
    Scheduled["Match SCHEDULED, deadline = now + 5 min"] --> CheckIn{"POST .../check-in"}
    CheckIn -- "first player" --> Waiting["Waiting for the opponent"]
    Waiting --> CheckIn
    CheckIn -- "second player" --> Start["Game created in the same transaction, player1 = White"]
    Scheduled --> Sweep{"Deadline passed (sweep every 10 s)"}
    Waiting --> Sweep
    Sweep -- "one checked in" --> Walkover["handleWalkover() for the absent player"]
    Sweep -- "nobody" --> Double["handleDoubleForfeit() (cascades)"]
    Sweep -- "both, no game (old data)" --> Start
```

**Check-in (`TournamentCheckInService`)** — `POST /api/tournaments/:id/matches/:matchId/check-in`:
- The caller is the session user; 403 `NOT_MATCH_PLAYER` if they are not player1/player2, 404 `MATCH_NOT_FOUND` if the match is not in the tournament, 409 `TOURNAMENT_NOT_IN_PROGRESS`.
- One conditional update: `SET playerX_checked_in_at = now() WHERE status = 'SCHEDULED' AND check_in_deadline > now() AND playerX_checked_in_at IS NULL`. The row lock serialises the two players and the sweep.
- No row updated: a repeated check-in returns 200 with the current state; otherwise 409 `MATCH_NOT_SCHEDULED` or `CHECK_IN_CLOSED`.
- The transaction that sees both timestamps creates the game (`createMatchGame`); the in-memory session starts after commit. The partial unique index `games_tournament_match_active_key` is a second guard against two live games.

**Deadline sweep (`TournamentCheckInSweeper`)** — `setInterval` every 10 s, `isExecuting` guard, state only in the DB:
- Selects `SCHEDULED` matches with an expired deadline, both players set, no winner, in an `IN_PROGRESS` tournament.
- Each match in its own transaction, locked with `SELECT ... FOR UPDATE` while it is still expired and `SCHEDULED`. If a check-in won the race, the row no longer matches and the sweep skips it.
- One player checked in -> `handleWalkover()`; nobody -> `handleDoubleForfeit()`; both but no game -> start the game.
- Any error after the lock means inconsistent data (for example the next match slot is already taken, or a live game exists for a `SCHEDULED` match). It is logged; after 5 failures in a row (`MAX_SWEEP_ATTEMPTS`) the match is no longer retried and is reported for a manual fix. Nobody is forfeited because of a data problem. The count and the skip list are in memory; a restart clears them.

**Final-round guard:** a match without `next_match_id` concludes the tournament only if it is in the last round. A lost bracket link (`next_match_id` is `ON DELETE SET NULL`) now gives a 409 and rolls back instead of finishing the tournament after a semifinal.

### 6. Recovery (`TournamentRecoveryService`)

Found in the review of PR #173. Live games exist only in memory, and the tournament listener runs after the game result is already saved. Three cases used to leave a match `IN_PROGRESS` forever:

1. The listener failed (for example a DB error): the result was saved but never applied to the bracket.
2. The backend restarted during a game: the `games` row stayed `IN_PROGRESS` with no session.
3. A game was removed before it ended (`ABORTED`): the listener ignores `ABORTED`.

How they are handled:

- **Startup** (`onApplicationBootstrap`): every tournament game still `IN_PROGRESS` is orphaned (no session can exist yet), so it is set to `ABORTED` with `end_reason = 'SERVER_RESTART'`. Regular games are not touched. This assumes a single backend instance.
- **Every 30 s:** find `IN_PROGRESS` matches of an `IN_PROGRESS` tournament whose latest game is not live and ended more than 30 s ago. The grace period leaves the normal path to the listener.
  - **Finished game** (win, draw, abandonment): `TournamentGameService.applyGameResult()` runs again. It is the same code the listener uses, so a draw starts its replay with swapped colours. Every bracket write is conditional, so a result is never applied twice: a racing listener gets a 409, which it logs as a no-op.
  - **`ABORTED` game:** the match goes back to `SCHEDULED` with check-ins cleared and a new 5 minute deadline. This is a conditional update (still `IN_PROGRESS`, no winner, no live game). From there the check-in rules apply. Draw replays already played still count.
  - Every change sends `match_updated` after commit (#168).
- **Errors:** counted per match. After 5 in a row (`MAX_RECOVERY_ATTEMPTS`) the match is no longer retried and is reported for a manual fix, the same policy as the check-in sweep.

No migration: `ABORTED` is already an allowed result and `end_reason` has no check constraint.

---

## 4. Developer Verification & Test Suites

All tests run inside the Docker container to ensure environment consistency:

```bash
# 1. Run pure mathematical bracket generator tests (14 test cases):
docker compose run --rm backend npm run test:tournament-bracket

# 2. Run database-integrated bracket service tests (25 test cases):
docker compose run --rm backend npm run test:tournament-bracket:service

# 2b. Run game -> tournament integration tests (15 test cases):
docker compose run --rm backend npm run test:tournament-games

# 2c. Run game gateway conclusion & board-ending move persistence tests (3 test cases):
docker compose run --rm backend npm run test:game-gateway

# 2d. Run real PostgreSQL tests (concurrency, unique indexes, end-to-end game flow).
#     The compose `migration` service only migrates the main database, so first apply
#     all migrations (incl. 20261104210000_tournament_system) to chess_test with the
#     OWNER role (same credentials as MIGRATION_DATABASE_URL, database name chess_test).
#     Rebuild the image after code changes: docker compose build backend
docker compose run --rm -e DATABASE_URL="postgresql://<owner-user>:<owner-secret>@postgres:5432/chess_test" backend npx prisma migrate deploy
#     Then run the suite with the APPLICATION role (never owner credentials):
docker compose run --rm -e TEST_DATABASE_URL="postgresql://chess_app:replace-with-app-secret@postgres:5432/chess_test" backend npm run test:tournament:db
#     P2021 "table public.tournaments does not exist" = migrations not applied to chess_test.
# 2e. Match check-in (#161): sweep decisions, then check-in / sweep against PostgreSQL
#     (apply the 20261108120000_tournament_match_check_in migration to chess_test first):
docker compose run --rm backend npm run test:tournament-checkin
docker compose run --rm -e TEST_DATABASE_URL="postgresql://chess_app:replace-with-app-secret@postgres:5432/chess_test" backend npm run test:tournament-checkin:db
# 2f. Recovery: decisions, then lost results / restart / aborted games against PostgreSQL:
docker compose run --rm backend npm run test:tournament-recovery
docker compose run --rm -e TEST_DATABASE_URL="postgresql://chess_app:replace-with-app-secret@postgres:5432/chess_test" backend npm run test:tournament-recovery:db

# 3. Run full backend regression suite (39 test cases):
docker compose run --rm backend npm test

# 4. Verify Docker build:
docker compose build backend
```
