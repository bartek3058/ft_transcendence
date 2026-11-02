# Match Conclusion & ELO Rating Persistence Architecture

## 1. Overview & Lifecycle Integration

In `ft_transcendence`, matches are tracked from initial queue matchmaking (`IN_PROGRESS`) through live real-time gameplay to final conclusion. 
When a match ends—whether through checkmate, draw, resignation, timeout, or abandonment—the backend must authoritatively:
1. Determine the decisive match result and winner.
2. Freeze in-memory game state so no further moves can be accepted.
3. Flush remaining in-flight moves to PostgreSQL `game_moves`.
4. Atomically persist final match metadata (`result`, `end_reason`, `game_end`) to PostgreSQL table `games`.
5. Trigger atomic ELO rating adjustments via `RatingService.applyGameResult(gameId)`.
6. Purge the match from server RAM.

This lifecycle is implemented in [`GameService.removeGame()`](../backend/src/game/game.service.ts) and contracts defined in [`src/game/types/chess.types.ts`](../backend/src/game/types/chess.types.ts).

---

## 2. Match Conclusion Data Flow

```mermaid
flowchart TD
    Trigger["Game Termination Trigger (WS Event / Gateway / Engine)"] -->|removeGame(gameId, conclusion?)| Service["GameService.removeGame"]
    Service -->|1. Priority Resolution| Outcome["PersistedGameConclusion"]
    Outcome -->|2. Freeze Session| RAM["GameSession (isFinished = true)"]
    Service -->|3. Flush Plies| Buffer["flushPendingMoves() -> game_moves"]
    Service -->|4. Conditional SQL Update| Postgres[("PostgreSQL: games WHERE result = 'IN_PROGRESS'")]
    Postgres -->|Row Updated (count === 1)| Rating["RatingService.applyGameResult(gameId)"]
    Postgres -->|Row Not Updated (Already Concluded)| Skip["Skip Rating (Idempotent Lock)"]
    Rating -->|Atomic Elo Recalculation| UserRatings[("Update Users Rating & Game Deltas")]
    Service -->|5. Purge Session| FreeRAM["activeGames.delete(gameId)"]
```

---

## 3. Resolution Priority Hierarchy

Match termination reasons are evaluated in order of priority:

1. **Explicit Caller Conclusion (`GameConclusion`)**:
   Passed by WebSocket gateways or disconnection monitors for conditions undetectable by the chess engine itself:
   - `RESIGNATION`: Caller provides resigning player; opponent is marked as winner.
   - `TIMEOUT`: Clock expires; player with time remaining is marked as winner.
   - `ABANDONMENT`: Disconnection grace period expires.
2. **Session Pre-Concluded State**:
   If `session.isFinished` was already set by engine move execution.
3. **Engine Board State (`chess.js`)**:
   - `engine.isCheckmate()`: Decisive victory for the player who just moved (`WHITE_WON` or `BLACK_WON`).
   - Draw evaluation:
     - `engine.isStalemate()` $\to$ `STALEMATE`
     - `engine.isInsufficientMaterial()` $\to$ `INSUFFICIENT_MATERIAL`
     - `engine.isThreefoldRepetition()` $\to$ `THREEFOLD_REPETITION`
     - `engine.isDraw()` $\to$ `FIFTY_MOVE_RULE`
4. **Fallback (Early Removal / Cancel)**:
   - If removed before conclusion, marked as `ABORTED` with `endReason: null` (unrated).

> [!IMPORTANT]
> **Draw Invariant (`DRAW_REASONS`)**:
> Any conclusion matching `'STALEMATE' | 'INSUFFICIENT_MATERIAL' | 'THREEFOLD_REPETITION' | 'FIFTY_MOVE_RULE'` is guaranteed to have `winnerColor: null` and result `'DRAW'`, regardless of any caller arguments.

---

## 4. Concurrency & Security Invariants

### 1. In-Flight Call De-duplication (`concludingGames`)
A match conclusion can be triggered concurrently (e.g. mutual resignation, clock timeout arriving simultaneously with a resignation event).
`GameService` tracks in-flight terminations using a `Set<string> concludingGames`. If a concurrent call arrives for the same `gameId`, it is safely ignored and returns `false`.

### 2. Idempotent Database Conditional Lock
PostgreSQL `games` rows are updated with:
```typescript
const { count } = await this.prisma.game.updateMany({
  where: { id: gameId, result: 'IN_PROGRESS' },
  data: {
    result: final.result,
    endReason: final.endReason,
    gameEnd: new Date(),
  },
});
```
Because the update matches `result: 'IN_PROGRESS'`, exactly one caller will match the row (`count === 1`). Subsequent calls find zero matching rows, guaranteeing that rating recalculations cannot fire multiple times.

### 3. Format Validation Defense
Before making any database queries, `gameId` is validated against `UUID_REGEX`:
```typescript
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
```
Malformed IDs (e.g. from in-memory test fixtures or bad requests) return immediately without triggering PostgreSQL syntax errors (`22P02`).

### 4. Fault Resilience & Recovery
- **Database Write Failure**: If the database is unreachable, the session is kept in server memory (frozen). `removeGame()` returns `false`, allowing the caller to retry.
- **Rating Calculation Failure**: If `RatingService.applyGameResult(gameId)` throws (e.g. due to a transient lock conflict), the error is logged and the session is purged from RAM. Because the match outcome is already safely committed to PostgreSQL, `applyGameResult(gameId)` can be re-run out-of-band.

---

## 5. Verification Commands

### Unit Tests (14 Tests)
Validates checkmate, stalemate, draws, resignation, timeouts, double-conclusion guards, format checks, and error branches:
```bash
docker compose run --rm backend npm run test:game-conclusion
```

### PostgreSQL Integration Tests (5 Tests)
Validates real database transactions, conditional `IN_PROGRESS` locks, and atomic Elo updates:
```bash
docker compose run --rm -e TEST_DATABASE_URL="postgresql://chess_app:replace-with-app-secret@postgres:5432/chess_test" backend npm run test:game-conclusion:db
```
