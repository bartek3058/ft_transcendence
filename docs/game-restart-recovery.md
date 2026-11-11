# Live Game Restart Recovery (Issue #76)

## 1. Overview

Live games are kept only in RAM: `GameService.activeGames` holds the chess.js engine, clocks
and players of every running match. A backend restart (deploy, crash, `docker compose restart`)
wipes that map, but the matching `games` rows stay `IN_PROGRESS` and every saved ply is still in
`game_moves`.

Before this change the result was a "zombie" game: clients reconnected, got `GAME_NOT_FOUND`
(or `game:no-active`), and the row was never concluded or rated.

Now `GameService` rebuilds those games on startup, so players reconnect to the same position
with the same clocks.

---

## 2. Startup Flow

`GameService` implements `OnApplicationBootstrap`. The hook runs before the HTTP/WebSocket
server accepts clients and calls `recoverInterruptedGames()`:

```
onApplicationBootstrap()
  └─ recoverInterruptedGames()
       1. updateMany: AI games IN_PROGRESS            -> ABORTED (SERVER_RESTART)
       2. findMany:   IN_PROGRESS casual + active tournament games, moves ordered by ply
       3. for each game:
            already in activeGames?   -> skip
            rebuildSession() == null  -> ABORTED (SERVER_RESTART)
            position is game over     -> removeGame()  (persist + rate)
            otherwise                 -> activeGames.set()  ("Restored game session [...]")
```

Recovery includes unfinished casual games and games linked to an unfinished match in an active tournament:

| Game type | Action |
| :--- | :--- |
| Tournament (`tournament_match_id` set) | Restored with the same ID, moves and clocks when the match and tournament are IN_PROGRESS. |
| AI (`white_id` or `black_id` = `AI_BOT_USER_ID`) | `ABORTED`, `end_reason = 'SERVER_RESTART'`. Not rated. The Stockfish side is not restored. |
| Casual | Rebuilt from `game_moves` and put back in `activeGames`. |
| Human game with damaged history | `ABORTED`, `end_reason = 'SERVER_RESTART'`. |
| Casual whose last saved move ended the game | Concluded through `removeGame()` (result persisted, rating applied). |

The method returns `{ restored, aborted, concluded }` for tests and logging. Any error is logged
and the boot continues.

---

## 3. Rebuilding a Session (`rebuildSession`)

1. **Players**: `white_id` and `black_id` must both be set and different. A deleted user
   (`ON DELETE SET NULL`) makes the game unrestorable.
2. **Move replay**: moves are replayed in `ply` order into a new `Chess()` from their `uci`
   (`e2e4`, `e7e8q`). Ply `n` must exist with the expected colour (`WHITE` on odd plies).
   A gap, a wrong colour or an illegal move aborts the game.
3. **Clocks**: each side gets the `time_remaining_ms` of its last saved move. A side that has not
   moved keeps the default 600 000 ms (the same default `createGame()` uses).
4. **Clock restart**: `lastMoveTimestamp` is set to the boot time. The DB knows when the last
   move was played, not when the server went down, so the outage is not charged to the player to
   move. The trade-off is that this player also gets back the thinking time spent before the crash.
5. **Game-over check**: `evaluateGameOverState()` runs on the final position. If it is already
   checkmate or a draw, the session is concluded right away.

The rebuilt session is a normal `GameSession`: the gateway's 250 ms clock loop, timeouts, moves,
resignations and conclusions work on it unchanged.

---

## 4. Client Behaviour

No protocol change was needed. After every (re)connection the gateway emits `game:ready` and the
frontend (`useMatchmaking.ts`) sends `game:join` with the known game id, or `game:resume`:

- Restored game: `game:joined` with the authoritative FEN, move list and clocks.
- Aborted game: `getFinishedGameForPlayer()` finds the `ABORTED` row and the client receives
  `game:finished`, not `GAME_NOT_FOUND`.

---

## 5. Constants

`SERVER_RESTART_REASON = 'SERVER_RESTART'` lives in `backend/src/game/types/chess.types.ts`.
`tournament-recovery.service.ts` imports it from there and re-exports it, so tournament and
casual/AI restart aborts share one `end_reason` value.

---

## 6. Limits

- **Hard kill**: a move still in the cold-path buffer (see
  [move-history-persistence.md](move-history-persistence.md)) when the process is killed with
  SIGKILL is lost; the game resumes from the last saved ply. A graceful stop flushes the buffer
  in `onModuleDestroy`.
- **Single instance**: recovery assumes one backend process. Two instances would each load the
  same games.
- **Nginx**: recreating the backend container (`docker compose up -d --build backend`) can give
  it a new IP. Nginx resolves `backend` once, so run `docker compose restart nginx` afterwards to
  avoid 502 errors. `docker compose restart backend` keeps the container and does not need this.

---

## 7. Testing & Verification

### Unit Tests (12 Tests)
Fake Prisma with the same `where` filters the service uses. Covers restored position and clocks,
default clock for a side that has not moved, a game with no moves, promotion replay, AI abort,
tournament and finished games left alone, ply gap, illegal move, missing player, a checkmate
concluded and rated on startup, an existing session not overwritten, and a boot that survives a
database error:
```bash
docker compose run --rm backend npm run test:game-recovery
```

### Manual Check on a Live Game
1. Start a casual game between two users and play a few moves.
2. Kill the backend: `docker compose kill backend`.
3. Start it again: `docker compose start backend` (or rebuild with
   `docker compose up -d --build backend && docker compose restart nginx`).
4. Check the log: `docker compose logs backend | grep -E 'Restored|Aborted'` should show
   `Restored game session [<id>] after restart at ply <n>.`
5. Reload both clients: same position, same move list, clocks as at the last move.
6. Repeat with an AI game: the row becomes `ABORTED` / `SERVER_RESTART` and the client shows the
   game as finished.


## Tournament restart regression (11 November 2026)

GameService is the only owner of session restoration. TournamentRecoveryService
never aborts ongoing games at bootstrap: it only reconciles already-ended games.
Unrestorable histories are still aborted and reopened for check-in by that worker.
Finished/aborted responses clear the old frontend board and offer a return link.
Shutdown hooks flush queued moves on graceful termination. A hard kill can still
lose moves not yet committed; recovery uses the last persisted position. Clocks
resume at backend startup from saved per-player values, not when both users rejoin.
Outage time is not deducted; thinking time since the last saved move may be refunded.

Run backend `npm run test:game-recovery`, `npm run test:tournament-recovery` and
`npm run test:tournament-games`. With a separately prepared test database, run
`npm run test:tournament-recovery:db` using TEST_DATABASE_URL.

Manual verification:
1. Start a tournament, check in both players, and play several moves.
2. Run `docker compose down` (never `down -v`), then `docker compose up --build -d`.
3. Reconnect both browsers to the existing game URL. Confirm the same position,
   move history and game ID; no replacement check-in is required.
4. Make another move, resign or finish the game, and verify the bracket advances
   exactly once and the original game row contains the result.
5. Repeat with a browser refresh and with disconnection during the final move.
