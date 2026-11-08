# Tournaments API: frontend contract (#102, for #155)

Registration and lifecycle routes for single-elimination tournaments. The bracket
engine behind them is described in `tournament-bracket-engine.md`.

Base path: `/api/tournaments`, served over HTTPS through Nginx.

## Request rules

Every route needs a logged-in session (the `__Host-session` cookie, sent by the
browser). `POST` routes also need:

- `Origin` equal to the app origin (`APP_ORIGIN`, default `https://localhost`)
- `X-CSRF-Protection: 1`
- `Content-Type: application/json`
- a JSON object body with only the documented keys and no nested objects.
  `join`, `leave`, `close-registration` and `cancel` take an empty body `{}`.

`:id` must be a UUID, otherwise `400 INVALID_ID` (checked before any database access).

Checks run in this order: id format and headers, per-IP limit, session, per-user
limit, then the database.

| Limit (sliding 60 s window) | Requests |
|---|---|
| Per IP, all routes | 180 |
| Per user, `GET` | 120 |
| Per user, `POST` | 30 |

Every response, errors included, has `Cache-Control: no-store`.

Dates are ISO 8601 strings in UTC.

## Errors

All errors use one shape:

```json
{ "error": { "code": "TOURNAMENT_FULL", "message": "Tournament is full." } }
```

Validation errors (`400 INVALID_INPUT`) may add `fields: [{ field, code }]`.
`429` and `503` responses carry a `Retry-After` header (seconds).

| Status | Code | When |
|---|---|---|
| 400 | `INVALID_ID` | `:id` is not a UUID |
| 400 | `INVALID_INPUT` | body or query failed validation |
| 400 | `DEADLINE_TOO_SOON` | deadline less than 5 minutes ahead |
| 400 | `DEADLINE_TOO_FAR` | deadline more than 30 days ahead |
| 401 | `UNAUTHENTICATED` | no valid session |
| 403 | `REQUEST_ORIGIN_REJECTED` | wrong `Origin` or missing CSRF header |
| 403 | `FORBIDDEN` | close/cancel by someone who is not the creator or an admin |
| 404 | `TOURNAMENT_NOT_FOUND` | unknown id |
| 409 | `TOURNAMENT_FULL` | join with no free slot |
| 409 | `ALREADY_JOINED` | join twice |
| 409 | `NOT_JOINED` | leave without being registered |
| 409 | `REGISTRATION_CLOSED` | join/leave/close after the deadline or once registration is closed |
| 409 | `TOURNAMENT_NOT_CANCELLABLE` | cancel once the tournament has started, finished or was cancelled |
| 403 | `NOT_MATCH_PLAYER` | check-in by someone who is not a player of the match |
| 404 | `MATCH_NOT_FOUND` | unknown match, or a match of another tournament |
| 409 | `TOURNAMENT_NOT_IN_PROGRESS` | check-in while the tournament is not running |
| 409 | `MATCH_NOT_SCHEDULED` | check-in for a match that is not waiting for players |
| 409 | `CHECK_IN_CLOSED` | check-in after the match's deadline |
| 400 | `SELF_INVITE` | inviting yourself |
| 403 | `NOT_ALLOWED_TO_INVITE` | inviting without being the creator or a registered player |
| 403 | `NOT_FRIEND` | inviting someone who is not an accepted friend |
| 409 | `ALREADY_INVITED` | the player already has a pending invitation to this tournament |
| 404 | `INVITATION_NOT_FOUND` | unknown invitation, or one addressed to someone else |
| 409 | `INVITATION_EXPIRED` | answering after the deadline or after registration ended |
| 409 | `INVITATION_ALREADY_ANSWERED` | changing an answer (decline after accept, accept after decline) |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | `POST` without `application/json` |
| 429 | `RATE_LIMITED` | limit exceeded |
| 503 | `TOURNAMENTS_BUSY` / `TOURNAMENTS_UNAVAILABLE` | overload or temporary failure; retry later |

## Lifecycle

```
OPEN_FOR_SIGNUP --close (manual or deadline)--> IN_PROGRESS --final played--> FINISHED
       |                       \-- fewer than 2 players --> CANCELLED
       \--cancel (creator/admin)--> CANCELLED
```

- The creator does not join automatically; they use `join` like everyone else.
- A full tournament stays open until its deadline. The creator or an admin may close it earlier.
- A background job checks every 60 seconds and closes registrations whose deadline has passed.
  The UI should expect up to about a minute between the deadline and the status change,
  but join and leave are refused as soon as the deadline passes.
- `REGISTRATION_CLOSED` is only a short internal step; the API normally shows the result
  (`IN_PROGRESS` or `CANCELLED`).
- Cancel works only before the tournament starts. Participant rows are kept.

## Shared shapes

```ts
type TournamentStatus = 'OPEN_FOR_SIGNUP' | 'REGISTRATION_CLOSED' | 'IN_PROGRESS' | 'FINISHED' | 'CANCELLED';

interface UserRef { id: string; username: string }

interface TournamentSummary {
  id: string;
  title: string;
  description: string | null;
  status: TournamentStatus;
  maxParticipants: 2 | 4 | 8 | 16 | 32;
  currentParticipants: number;
  registrationDeadline: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  creator: UserRef;
  champion: UserRef | null;
}
```

Responses never include a player's live rating. The only rating shown is
`seedRating`, frozen when registration closes.

## Routes

### `POST /api/tournaments` (201)

```json
{
  "title": "Autumn Cup",
  "description": "Optional, may be omitted or null",
  "maxParticipants": 8,
  "registrationDeadline": "2026-11-20T18:00:00Z"
}
```

- `title`: 3-64 characters after trimming, no control characters.
- `description`: optional, up to 255 characters, single line. Empty is stored as `null`.
- `maxParticipants`: 2, 4, 8, 16 or 32 (a JSON number).
- `registrationDeadline`: full date-time with `Z` or an offset, between 5 minutes and
  30 days from now.

Returns `TournamentSummary` with status `OPEN_FOR_SIGNUP` and the caller as creator.

### `GET /api/tournaments?status=open|live|past&limit=&offset=` (200)

| Tab | Statuses | Order |
|---|---|---|
| `open` (default) | `OPEN_FOR_SIGNUP` | deadline, soonest first |
| `live` | `REGISTRATION_CLOSED`, `IN_PROGRESS` | started most recently first |
| `past` | `FINISHED`, `CANCELLED` | created most recently first |

`limit` 1-50 (default 20), `offset` 0-9999 (default 0).

```ts
{ items: TournamentSummary[]; total: number; limit: number; offset: number }
```

### `GET /api/tournaments/:id` (200)

`TournamentSummary` plus:

```ts
participants: {
  userId: string;
  username: string;
  seed: number | null;        // set when the bracket is generated
  seedRating: number | null;  // rating frozen at registration close
  finalRank: number | null;   // set when the tournament finishes
  registeredAt: string;
}[];                          // ordered by seed, then registration time

matches: {
  id: string;
  round: number;              // 1 = first round
  matchIndex: number;
  identifier: string;         // e.g. "R1-M1"
  status: 'PENDING' | 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'WALKOVER';
  isBye: boolean;
  player1: UserRef | null;
  player2: UserRef | null;
  winnerId: string | null;
  nextMatchId: string | null; // where the winner goes; null for the final
  nextMatchSlot: 'player1' | 'player2' | null;
  checkInDeadline: string | null; // set while SCHEDULED: both players must check in before it
  player1CheckedIn: boolean;
  player2CheckedIn: boolean;
  gameIds: string[];          // games of this match in play order (replays after draws)
  currentGameId: string | null;
}[];                          // ordered by round, then matchIndex; empty before the start
```

### `POST /api/tournaments/:id/join` (200)

Body `{}`. Returns `{ "currentParticipants": 5 }`. The last slot can never be
taken twice.

Errors: `404`, `409 TOURNAMENT_FULL`, `409 ALREADY_JOINED`, `409 REGISTRATION_CLOSED`.

### `POST /api/tournaments/:id/leave` (200)

Body `{}`. Returns `{ "currentParticipants": 4 }`. Only while registration is open
and before the deadline.

Errors: `404`, `409 NOT_JOINED`, `409 REGISTRATION_CLOSED`.

### `POST /api/tournaments/:id/close-registration` (200)

Body `{}`. Creator or admin only. Closes registration now and starts the bracket.

Returns `{ "status": "IN_PROGRESS" }`, or `{ "status": "CANCELLED" }` when fewer
than 2 players joined.

Errors: `403 FORBIDDEN`, `404`, `409 REGISTRATION_CLOSED`.

### `POST /api/tournaments/:id/cancel` (200)

Body `{}`. Creator or admin only. Returns `{ "status": "CANCELLED" }`.

Errors: `403 FORBIDDEN`, `404`, `409 TOURNAMENT_NOT_CANCELLABLE`.

### `POST /api/tournaments/:id/matches/:matchId/check-in` (200)

Body `{}`. Only player1 or player2 of the match. When a match becomes `SCHEDULED`,
both players have 5 minutes (`checkInDeadline`) to check in. The second check-in
starts the game at once (player1 plays White); the frontend can call this when the
match page opens and then join `gameId`.

```ts
{
  matchId: string;
  status: 'SCHEDULED' | 'IN_PROGRESS' | ...;
  checkInDeadline: string | null;
  player1CheckedIn: boolean;
  player2CheckedIn: boolean;
  gameId: string | null;      // set once the game started
}
```

A repeated call returns the current state, so it is safe to retry. After the
deadline the server resolves the match within about 10 seconds: the player who
checked in wins by walkover; if nobody checked in, both lose.

Errors: `403 NOT_MATCH_PLAYER`, `404 MATCH_NOT_FOUND`, `409 TOURNAMENT_NOT_IN_PROGRESS`,
`409 MATCH_NOT_SCHEDULED`, `409 CHECK_IN_CLOSED`.

## Invitations (#154)

Only accepted friends can be invited, by the creator or by a registered player, while
registration is open. One recipient per request: to invite several friends, the UI
lets the user tick them and sends one request per friend (watch the per-user write
limit of 30 requests per minute; on `429` wait `Retry-After` seconds).

An invitation expires at the tournament's registration deadline, or as soon as
registration ends (manual close, scheduler, cancel). A user can be invited again
after declining (for example after a wrong click), after an expiry, or after
accepting and then leaving. A user has at most one invitation per tournament.

### `POST /api/tournaments/:id/invitations` (201)

Body `{ "recipientId": "<uuid>" }`. Returns:

```ts
{ invitationId: string; tournamentId: string; recipientId: string; status: 'PENDING'; expiresAt: string }
```

Errors: `400 SELF_INVITE`, `403 NOT_ALLOWED_TO_INVITE`, `403 NOT_FRIEND`, `404`,
`409 REGISTRATION_CLOSED`, `409 ALREADY_JOINED`, `409 ALREADY_INVITED`.

### `GET /api/tournaments/invitations/me?limit=&offset=` (200)

The caller's pending invitations that can still be accepted (not expired, tournament
still open), soonest deadline first. `limit` 1-50 (default 20), `offset` 0-9999.

```ts
{
  items: {
    id: string;
    tournament: { id; title; status; maxParticipants; currentParticipants; registrationDeadline };
    sender: UserRef;
    createdAt: string;
    expiresAt: string;
  }[];
  total: number; limit: number; offset: number;
}
```

### `POST /api/tournaments/invitations/:id/respond` (200)

Body `{ "response": "ACCEPT" | "DECLINE" }`.

- `ACCEPT` joins the tournament exactly like `POST /:id/join` and returns
  `{ invitationId, tournamentId, status: "ACCEPTED", currentParticipants }`. If the
  tournament is full or closed the join's error is returned (`409 TOURNAMENT_FULL`,
  `409 REGISTRATION_CLOSED`) and the invitation stays pending.
- `DECLINE` returns `{ invitationId, tournamentId, status: "DECLINED" }`.
- Sending the same answer again returns the current state.
- Joining with `POST /:id/join` also accepts a pending invitation to that tournament.

Errors: `404 INVITATION_NOT_FOUND`, `409 INVITATION_EXPIRED`,
`409 INVITATION_ALREADY_ANSWERED`, plus the join errors above.

## Backend internals

Code lives in `backend/src/tournament/`.

### Components

| Part | File | Role |
|---|---|---|
| `TournamentsController` | `tournaments.controller.ts` | Routes; no logic. |
| `TournamentRequestGuard` | `http/tournaments-http.ts` | UUID format, Origin/CSRF, JSON, allowed body keys, per-IP limit. No I/O. |
| `SessionGuard` | `auth/session.guard.ts` | Session cookie (shared with the rest of the app). |
| `TournamentUserLimitGuard` | `http/tournaments-http.ts` | Per-user read/write limits. |
| `TournamentsExceptionFilter` | `http/tournaments-http.ts` | `{ error }` envelope, `no-store`, `Retry-After`; unknown errors become 503 without internals. |
| `TournamentsService` | `tournaments.service.ts` | Create, list, detail, join, leave; permission check for close/cancel. |
| `TournamentLifecycleService` | `tournament-lifecycle.service.ts` | Status transitions: close + start, stuck retry, cancel, give-up cancel. |
| `TournamentDeadlineScheduler` | `tournament-deadline.scheduler.ts` | 60 s `setInterval` that drives the lifecycle for expired registrations. |
| `TournamentEventsPublisher` | `tournament-events.publisher.ts` | In-process events after commit. |
| `TournamentBracketService` | `tournament-bracket.service.ts` | Bracket generation and progression (#68). |

Shared limits and rules are in `tournament-rules.ts` (title length, deadline window,
tabs, paging); the DTOs are in `dto/`. Response types are in
`types/tournament-response.types.ts`; players there are `{ id, username }` only.

Call flow for a manual close:

```
controller -> TournamentsService.closeRegistration (creator/admin check, role read from users)
           -> TournamentLifecycleService.closeAndStart(id, 'MANUAL')
                one transaction: claim row -> cancel (<2) or generateAndSaveBracket
           -> after commit: TournamentEventsPublisher.registrationClosed(...)
```

`TournamentModule` imports `AuthModule`, `DatabaseModule` and `GameModule`.
`GameModule` never imports `TournamentModule`.

### Concurrency

Every state change starts with one conditional statement on the `tournaments` row.
PostgreSQL row locks serialise racing requests; the loser re-checks the condition
after the winner commits and matches 0 rows.

| Operation | Statement (shortened) | Loser gets |
|---|---|---|
| join | `UPDATE ... SET current_participants + 1 WHERE status = 'OPEN_FOR_SIGNUP' AND current_participants < max_participants AND registration_deadline > now()` | `TOURNAMENT_FULL` / `REGISTRATION_CLOSED` |
| leave | `UPDATE ... SET current_participants - 1 WHERE status = 'OPEN_FOR_SIGNUP' AND registration_deadline > now() AND current_participants > 0` | `REGISTRATION_CLOSED` / `NOT_JOINED` |
| close (manual) | `UPDATE ... SET status = 'REGISTRATION_CLOSED' WHERE status = 'OPEN_FOR_SIGNUP' RETURNING current_participants` | `REGISTRATION_CLOSED` |
| close (scheduler) | same, plus `AND registration_deadline <= now()` | `REGISTRATION_CLOSED` (logged, skipped) |
| stuck retry | `SELECT ... WHERE status = 'REGISTRATION_CLOSED' FOR UPDATE` | `REGISTRATION_CLOSED` (logged, skipped) |
| cancel | `UPDATE ... SET status = 'CANCELLED' WHERE status IN ('OPEN_FOR_SIGNUP', 'REGISTRATION_CLOSED')` | `TOURNAMENT_NOT_CANCELLABLE` |

Details:

- Join inserts the `tournament_participants` row in the same transaction. A duplicate
  hits the `(tournament_id, user_id)` unique index (P2002); the error leaves the
  transaction callback, which rolls back the increment, and is mapped to `ALREADY_JOINED`.
- When the join `UPDATE` matches nothing, the reason is checked in this order:
  not found, already joined, closed or past deadline, full. A member of a full
  tournament therefore sees `ALREADY_JOINED`.
- Leave deletes the participant row after the decrement; if no row was deleted it
  throws, which rolls the decrement back (`NOT_JOINED`).
- Close and start run in one transaction. The `< 2` check reads `current_participants`
  from the locked row (join/leave keep it equal to the row count). With 2 or more,
  `generateAndSaveBracket` freezes `seed_rating`, assigns seeds and inserts all matches,
  then moves the tournament to `IN_PROGRESS`. A successful close never commits
  `REGISTRATION_CLOSED`.
- Cancel waits for an in-flight close; once the close commits `IN_PROGRESS`, the cancel
  matches 0 rows.

### Deadline scheduler

- Starts in `onModuleInit`, ticks every 60 s; the timer is `unref()`'d and cleared in
  `onModuleDestroy`. No npm package.
- `isExecuting` skips a tick while the previous one is still running.
- Each tick: (1) all `OPEN_FOR_SIGNUP` tournaments with `registration_deadline <= now()`
  go through `closeAndStart(id, 'SCHEDULER')`; (2) all tournaments in
  `REGISTRATION_CLOSED` go through `startClosed(id)` (recovery for old or hand-edited
  data). One transaction per tournament.
- A 404 or 409 means someone else handled the tournament: logged and skipped.
- Any other error is logged and counted per tournament. After 5 failures in a row
  (`MAX_START_ATTEMPTS`), `cancelUnstartable(id)` cancels the tournament, but only if
  it is still expired-open or `REGISTRATION_CLOSED`. A success or a lost race resets
  the count. The count is in memory, so a restart starts it again.
- Several backend instances are safe: the conditional statements let only one win.

### Events

`TournamentEventsPublisher` (Node `EventEmitter`, no dependency):

| Event | Payload | Published by |
|---|---|---|
| `onRegistrationClosed` | `{ tournamentId, outcome: 'IN_PROGRESS' \| 'CANCELLED', reason: 'MANUAL' \| 'SCHEDULER', at }` | close, scheduler, stuck retry, give-up cancel |
| `onCancelled` | `{ tournamentId, at }` | manual cancel |
| `onInvitationReceived` | `{ invitationId, tournamentId, senderId, recipientId, at }` | invite (new or re-sent) |
| `onInvitationAnswered` | same plus `status: 'ACCEPTED' \| 'DECLINED'` | respond, or a direct join that accepted a pending invitation |

Events are published only after the transaction commits, so a listener that reads the
database already sees the new state. Delivery uses `setImmediate`, so the request never
waits for listeners; a listener that throws or rejects is logged and does not affect
others. Every subscribe method returns an unsubscribe function. Nothing subscribes yet;
the WebSocket gateway of #168 will listen here.

### Invitations internals

- `TournamentInvitationsService` (`tournament-invitations.service.ts`) and
  `TournamentInvitationsController` (same guards, filter and pipeline as the other routes).
- Invite: one transaction. The tournament row is read `FOR SHARE`, so a concurrent
  close or cancel either waits or commits first (then the invite gets
  `REGISTRATION_CLOSED`). Then membership, friendship (`friendships` pair with
  `status = 'ACCEPTED'`) and participant checks, then one statement:
  `INSERT ... ON CONFLICT (tournament_id, recipient_id) DO UPDATE ... WHERE status <> 'PENDING' OR expires_at <= now()`.
  It creates a new row or refreshes an answered / expired one; a live pending invitation
  returns no row (`ALREADY_INVITED`), which also covers two senders at once.
- Accept reuses `TournamentsService.joinInTx` (the conditional join of #102). A failed
  join rolls back the whole transaction, so the invitation stays pending. `joinInTx`
  also marks the user's pending invitation `ACCEPTED`, so a direct join never leaves
  one behind.
- Lock order is always tournament row first, then invitation rows (invite, join,
  respond, close, cancel), so these operations cannot deadlock.
- `closeAndStart`, `startClosed`, `cancel` and `cancelUnstartable` set the tournament's
  `PENDING` invitations to `EXPIRED` in the same transaction.
- An invitation past `expires_at` but still `PENDING` in the table is treated as
  expired: hidden from `me`, refused by respond, and re-invitable.

### Data

Tables: `tournaments`, `tournament_participants`, `tournament_matches` (migration
`20261104210000_tournament_system`). These routes add no migration.

Database checks that back the API rules:

- `tournaments_title_check` (trimmed title at least 3 characters; the column is `VARCHAR(64)`)
- `tournaments_max_participants_check` (2, 4, 8, 16, 32)
- `tournaments_participants_bound_check` (0 <= current <= max)
- `tournament_participants_user_unique` (one entry per user)

The DTO rejects bad input first, so these never surface as PostgreSQL errors. Lengths
are counted in code points, the way PostgreSQL counts them, and lone surrogates are
rejected. Deadlines must include `Z` or an offset; the 5 minute to 30 day window is
checked in the service because it depends on the clock.

`seed_rating` is copied from `users.rating` when the bracket is generated and never
changes afterwards. No tournament response selects `users.rating`.

### Test suites

| Script | Covers | Cases |
|---|---|---|
| `test:tournaments:dto` | DTO validation through the real global pipe | 13 |
| `test:tournaments:http` | guard order, headers, body keys, limits, error filter | 14 |
| `test:tournaments:events` | deferred delivery, listener isolation, channels, unsubscribe | 5 |
| `test:tournaments:scheduler` | tick order, lost races, overlap guard, retry limit, timer | 7 |
| `test:tournaments:db` | real PostgreSQL: all routes, races, scheduler, events, cancel | 33 |
| `test:tournament-checkin` | check-in sweep decisions, retry limit, overlap guard, timer | 6 |
| `test:tournament-checkin:db` | real PostgreSQL: deadlines, check-in, concurrent check-ins, sweep races, walkover / double forfeit, final-round guard | 14 |
| `test:tournament-invitations` | invitation DTOs through the real global pipe | 4 |
| `test:tournament-invitations:db` | real PostgreSQL: permissions, friendship, re-invite, `me`, accept/decline, races (last slot, close, cancel, two senders), expiry, events | 15 |

The PostgreSQL suite only touches its own fixtures, but scheduler ticks also close
other expired tournaments in `chess_test`, so its assertions check each tournament
by id.

## Not covered here

- Live updates: the backend publishes in-process events after a close, cancel or
  invitation change (`TournamentEventsPublisher`), but no WebSocket channel sends them
  yet (#168). Until then
  the UI should reload the list or detail after an action, or poll.

## Tests

From the project root, after `docker compose build backend`:

```bash
docker compose run --rm backend npm run test:tournaments:dto
docker compose run --rm backend npm run test:tournaments:http
docker compose run --rm backend npm run test:tournaments:events
docker compose run --rm backend npm run test:tournaments:scheduler
docker compose run --rm -e TEST_DATABASE_URL="postgresql://chess_app:<app-secret>@postgres:5432/chess_test" \
  backend npm run test:tournaments:db
```

The database test needs `chess_test` migrated first (see `tournament-bracket-engine.md`).
