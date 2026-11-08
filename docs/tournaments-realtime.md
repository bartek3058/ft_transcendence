# Tournaments realtime: Socket.IO contract (#168, for #155)

Live tournament updates over Socket.IO, namespace `/tournaments`. Events are change
notifications; **REST stays the source of truth**. After connecting or reconnecting,
fetch `GET /api/tournaments/:id` (see `tournaments-api.md`) and then apply events.

## Connecting

```ts
import { io } from 'socket.io-client';

const socket = io('/tournaments', {
  transports: ['websocket'],
  withCredentials: true,     // sends the __Host-session cookie
  auth: { csrf: '1' },       // required, like X-CSRF-Protection on REST
});
socket.on('tournament:ready', () => { /* subscribe here, then refetch */ });
socket.on('connect_error', (err) => { /* 'TOURNAMENTS_CONNECTION_REJECTED': not logged in */ });
```

The connection is refused (`TOURNAMENTS_CONNECTION_REJECTED`) without a valid session,
with a foreign `Origin`, without `auth.csrf = '1'`, or after too many attempts from one
IP (60 per minute). A logged-out or expired session loses its sockets within 15 seconds
(at once on logout).

Every socket automatically receives the events of its own user (invitations).

## Subscribing to a tournament

```ts
const ack = await socket.emitWithAck('tournament:subscribe', { tournamentId });
// { ok: true } or { ok: false, error: { code } }
await socket.emitWithAck('tournament:unsubscribe', { tournamentId });
```

| Error code | When |
|---|---|
| `INVALID_ID` | payload is not exactly `{ tournamentId: <uuid> }` (checked without database access) |
| `RATE_LIMITED` | more than 30 subscribes per minute per user |
| `TOO_MANY_SUBSCRIPTIONS` | more than 20 tournaments on one socket |
| `TOURNAMENT_NOT_FOUND` | unknown tournament |
| `TOURNAMENTS_UNAVAILABLE` | temporary database problem; retry |

Subscribing again to the same tournament is fine. Socket.IO forgets rooms on reconnect:
subscribe again in the `tournament:ready` handler.

## Events (server -> client)

Dates are ISO strings. Payloads never contain emails, session data or live ratings; the
only rating is the frozen `seedRating`.

| Event | Who receives it | Payload |
|---|---|---|
| `tournament:participant_joined` | tournament subscribers | `{ tournamentId, currentParticipants, maxParticipants, participant: { userId, username } }` |
| `tournament:participant_left` | tournament subscribers | same as joined |
| `tournament:registration_closed` | tournament subscribers | `{ tournamentId, status: 'IN_PROGRESS' \| 'CANCELLED' }` |
| `tournament:started` | tournament subscribers | `{ tournamentId, participants, matches }` (same shapes as the REST detail) |
| `tournament:cancelled` | tournament subscribers | `{ tournamentId, status: 'CANCELLED' }` |
| `tournament:match_updated` | tournament subscribers | `{ tournamentId, match }`, see below |
| `tournament:finished` | tournament subscribers | `{ tournamentId, championId \| null, finalRanks: [{ userId, username, finalRank }] }` |
| `tournament:invitation_received` | the invited user | `{ invitation: { id, tournamentId, title, sender: { userId, username }, expiresAt } }` |
| `tournament:invitation_answered` | the user who sent the invitation | `{ invitation: { id, tournamentId, title, recipient: { userId, username }, status: 'ACCEPTED' \| 'DECLINED' } }` |

```ts
match: {
  id: string;              // the bracket match (stable for the whole pairing)
  round: number;
  identifier: string;      // "R1-M1"
  status: 'PENDING' | 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'WALKOVER';
  player1Id: string | null;
  player2Id: string | null;
  winnerId: string | null;
  checkInDeadline: string | null;
  player1CheckedIn: boolean;
  player2CheckedIn: boolean;
  currentGameId: string | null; // the chess game to open on /game (changes after a draw replay)
}
```

When they are sent:

- Close (manual or by the deadline scheduler): `registration_closed`, then `started`
  with the bracket, or `cancelled` with fewer than 2 players.
- One result can change several matches (the winner fills the next match, walkovers
  and double forfeits cascade up to the Final). Each changed match gets its own
  `match_updated`.
- `match_updated` is also sent for each check-in, when the game starts (both checked
  in), and when a draw replay starts (new `currentGameId`).
- A direct `POST /join` that accepts a pending invitation sends both
  `participant_joined` and `invitation_answered`.
- Nothing is sent for a request that failed or was rolled back.

## Backend

| Part | File | Role |
|---|---|---|
| `TournamentsGateway` | `backend/src/tournament/realtime/tournaments.gateway.ts` | Namespace, handshake checks, rooms, limits, session revalidation, publisher -> rooms |
| `TournamentRealtimePayloads` | `backend/src/tournament/realtime/tournament-realtime.payloads.ts` | Reads payloads after commit (snapshot reuses the REST detail query) |
| `TournamentEventsPublisher` | `backend/src/tournament/tournament-events.publisher.ts` | The only emission point: published after commit, deferred, listener errors isolated |

- Services never talk to Socket.IO. They publish in-process events after their
  transaction commits: `participantJoined/Left` (join, leave, invitation accept),
  `registrationClosed`, `cancelled`, `invitationReceived/Answered`, and
  `bracketChanged(tournamentId, matchIds, finished)` (game results, replays, game
  start, check-in, check-in sweep).
- `TournamentBracketService` returns `changedMatchIds` and `tournamentFinished` in
  `AdvanceWinnerResult`, so a cascade reports every match it touched.
- Rooms: `tournament:<id>` (subscribers) and `user:<id>` (every socket of that user).
- Limits: 60 connects per IP per minute, 30 subscribes per user per minute, 20 rooms
  per socket, 10 sockets per user, 10 000 sockets in total.
- A failing payload load or emit is logged by the publisher and never affects the
  HTTP request or the game conclusion that caused it.
- Nginx already proxies `/socket.io/`; no change needed.

## Tests

```bash
docker compose build backend
docker compose run --rm backend npm run test:tournaments:gateway
docker compose run --rm -e TEST_DATABASE_URL="postgresql://chess_app:<app-secret>@postgres:5432/chess_test" \
  backend npm run test:tournaments:realtime:db
```

| Script | Covers |
|---|---|
| `test:tournaments:gateway` (11) | handshake checks, connect limit, personal room, socket cap, revocation; subscribe validation without I/O, room cap, rate limit; event -> room / name / payload mapping, one event per changed match |
| `test:tournaments:realtime:db` (4) | real app + `socket.io-client` + PostgreSQL: rejected connections; subscribe acks; invitation received / answered, participant joined / left, no event on a failed join, registration_closed + started, check-in `match_updated` and `currentGameId`; double-forfeit cascade (one `match_updated` per changed match, then `finished`); #161 check-in over HTTP (400, 401, 403, 409) |
