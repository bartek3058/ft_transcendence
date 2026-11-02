# Move History Persistence & Cold-Path Architecture

## 1. Overview & Architectural Motivation

In `ft_transcendence`, gameplay operates under a **hybrid Hot-Path / Cold-Path** architecture:
- **Hot Path (RAM / WebSockets)**: Real-time game state (`GameSession`), move validation via `chess.js`, and countdown timers run strictly in server memory. Every move verified through `executeMove()` returns a `MoveExecutionResult` in $< 1\text{ ms}$ without awaiting database I/O.
- **Cold Path (PostgreSQL)**: Verified moves must be persisted permanently into PostgreSQL table `game_moves` to power game replays, historical breakdowns (`/api/v1/matches/:id`), and PGN exports.

The Move History Persistence worker (`GameService` & `move-persistence.ts`) decouples the two pipelines, buffering plies in RAM and persisting them asynchronously in batches while guaranteeing zero dropped moves, bounded RAM overhead, and fault isolation.

---

## 2. Hybrid Data Pipeline Flow

```mermaid
flowchart TD
    Client["Client / WebSocket Gateway"] -->|executeMove()| Engine["GameService Engine (Hot Path)"]
    Engine -->|1. Validate Move (chess.js)| Session["GameSession (RAM)"]
    Engine -->|2. Enqueue Ply| Buffer["pendingMovesQueue (RAM Buffer)"]
    Engine -->|3. Immediate Ack| Client
    Buffer -.->|scheduleFlush (Debounced 50ms)| Worker["Cold-Path Worker Loop"]
    Worker -->|batch up to 50 plies| BatchInsert["Prisma createMany(skipDuplicates)"]
    BatchInsert -->|Success| Postgres[("PostgreSQL: game_moves")]
    BatchInsert -->|Transient Failure| Backoff["Exponential Backoff Retry"]
    BatchInsert -->|Permanent Failure| Fallback["persistRowByRow Isolation"]
    Fallback -->|Bad Record| DeadLetter["deadLetterMoves Queue"]
    Fallback -->|Valid Records| Postgres
```

---

## 3. Configuration & Constants (`MOVE_PERSISTENCE_CONFIG`)

All thresholds and timings are defined in [`src/game/move-persistence.ts`](../backend/src/game/move-persistence.ts):

| Parameter | Default Value | Description |
| :--- | :--- | :--- |
| `batchSize` | `50` | Maximum number of plies written in a single `createMany()` call. |
| `flushDelayMs` | `50ms` | Debounce window allowing plies from simultaneous matches to be batched into a single SQL `INSERT`. |
| `retryBaseMs` | `250ms` | Base backoff interval for transient database errors. |
| `retryMaxMs` | `10,000ms` | Maximum backoff cap for transient retries. |
| `maxQueueSize` | `10,000` | Soft threshold for the in-RAM buffer. Exceeding logs critical errors without dropping plies. |
| `maxDeadLetters`| `1,000` | Ring buffer size for permanently rejected poison moves kept for debugging/inspection. |
| `removeGameWaitMs` | `5,000ms` | Maximum time `removeGame(gameId)` waits for a finished game's moves to commit before freeing session RAM. |
| `shutdownWaitMs` | `5,000ms` | Grace period in `onModuleDestroy()` to drain pending moves before NestJS server termination. |

---

## 4. Fault Tolerance & Poison Record Isolation

### Error Classification
Database errors are partitioned into two categories by `classifyPersistenceError()`:
1. **Transient Errors**:
   - Prisma connection/timeout codes: `P1001` (unreachable), `P1002` (server timeout), `P1008` (op timeout), `P1017` (connection closed), `P2024` (pool timeout), `P2034` (write conflict/deadlock).
   - Socket error codes: `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EPIPE`.
   - Node error names: `PrismaClientInitializationError`, `PrismaClientRustPanicError`.
   - *Behavior*: Plies remain at the head of `pendingMovesQueue`. The worker schedules a retry with exponential backoff:
     $$\text{delay} = \min(\text{retryMaxMs}, \text{retryBaseMs} \times 2^{\text{attempt}-1})$$
2. **Permanent Errors**:
   - Foreign key violations (`P2003`), CHECK constraint failures (`P2000`, `P2020`), or invalid data types (`P2023`).
   - *Behavior*: A bad ply in a 50-move batch must not prevent the other 49 valid moves from persisting. The batch falls back to `persistRowByRow()`. The offending record is recorded in `deadLetterMoves` with its error message and shifted from the queue, allowing all healthy plies to commit immediately.

### Idempotency & Duplicate Safety
The PostgreSQL table enforces:
```sql
CONSTRAINT "game_moves_game_id_ply_key" UNIQUE ("game_id", "ply")
```
All inserts run with `createMany({ skipDuplicates: true })`. If a batch write succeeds in PostgreSQL but the acknowledgment is interrupted by a network blip, the subsequent retry safely absorbs the already-written plies without throwing duplicate key exceptions (`P2002`).

---

## 5. Lifecycle & Teardown Guarantees

### Game Termination Barrier (`removeGame`)
When a match ends (e.g. checkmate, resignation, abandonment), the game session must not be deleted from RAM while moves are still in flight. 
`removeGame(gameId)` invokes `waitForPersistence(5000, gameId)`:
- Flushes the queue and polls until all plies for that `gameId` are confirmed written to disk.
- If the database is completely down, it times out after 5 seconds, logs an alert, and retains the unwritten plies in the global retry buffer so they are not lost.

### Graceful Shutdown (`onModuleDestroy`)
`GameService` implements the NestJS `OnModuleDestroy` lifecycle hook. On `SIGTERM` or `SIGINT`, timers are cleared and `waitForPersistence(shutdownWaitMs)` attempts a clean final flush before the process exits.

---

## 6. Testing & Verification

### Unit Tests (14 Tests)
Validates debounce batching, batch limits, retry backoff calculation, duplicate absorption, dead-letter fallback, and shutdown safety using pure fakes:
```bash
docker compose run --rm backend npm run test:game-moves
```

### PostgreSQL Integration Tests (6 Tests)
Validates real database transactions, cascade deletions, foreign key enforcement, 120-ply match persistence, and field constraints against the live PostgreSQL container:
```bash
docker compose run --rm -e TEST_DATABASE_URL="postgresql://chess_app:replace-with-app-secret@postgres:5432/chess_test" backend npm run test:game-moves:db
```
