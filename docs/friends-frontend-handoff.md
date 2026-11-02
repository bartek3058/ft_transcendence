# Friends backend: frontend handoff

Implemented in `git_friends`. No frontend files were changed. This document is the
contract for the teammate implementing the UI. Friends contributes to the subject's
user-interaction and standard user-management modules; chat, profile editing and
avatar uploads remain separate work.

## Deployment and migration

Use Node 22. The new additive migration is `202610270001_friends`; do not reset the
existing database or edit `0_init`. Existing accounts, sessions and games remain.

With configured root `.env`, from the project root:

```bash
sudo docker compose up --build -d
sudo docker compose logs --tail=100 migration backend
```

The migration service uses owner credentials and the backend uses application
credentials. The existing default grants cover the new table. For local tooling:

```bash
cd backend
npm ci
npm run prisma:generate
DATABASE_URL='<owner URL>' npm run prisma:migrate:deploy
```

Run the app behind HTTPS/Nginx. The existing `/socket.io/` proxy supports the new
namespace; `/friends` is a Socket.IO namespace, not the HTTP API or transport path.

## Shared HTTP rules

All endpoints require the existing `__Host-session` cookie. Use same-origin
relative URLs and `credentials: 'same-origin'`. Never read the HttpOnly cookie or
send a user ID as the caller's identity. Backend derives the actor from the session.

For POST and DELETE:

- `Content-Type: application/json`
- `X-CSRF-Protection: 1`
- Browser Origin must match backend `APP_ORIGIN` exactly.
- Send the documented JSON body. For accept/cancel/remove, send `{}`.
- Unknown fields, arrays, nested values and malformed UUIDs are rejected.

Do not set Origin manually in browser code; the browser sends it. Responses use
`Cache-Control: no-store`. Backend JSON limit is 16 KiB.

Pagination: `limit` defaults to 20 (1–50); `offset` defaults to 0 (0–9999).
Return shape: `{ items: [...], hasMore: boolean, offset: number, limit: number }`.
Send offset + limit to load more. Lists use creation time descending then ID;
search uses username ascending then ID. Re-fetch from offset 0 after changes to
avoid stale offset pagination during concurrent edits. No total-count field.

Public user shape is `{ id: string, username: string, rating: number }`. It does
not include email, password hash, role, session information or an avatar URL.
Frontend can render initials until avatar support is implemented.

## Endpoints

| Method and URL | Body/query | Success |
|---|---|---|
| GET `/api/users/search?q=alice` | Required q: 3–20 username characters, normalized trim/lowercase; prefix search; optional pagination | 200 paginated public users, excluding yourself |
| GET `/api/users/:id` | User UUID | 200 `{ user: PublicUser }` |
| GET `/api/friends` | Optional pagination | 200 paginated accepted friends |
| GET `/api/friends/requests` | Optional `direction=incoming` or `outgoing`; omitted returns both; pagination | 200 paginated pending requests |
| POST `/api/friends/requests` | `{ "targetUserId": "<uuid>" }` | 201 `{ request: { id, status: "PENDING", createdAt } }` |
| POST `/api/friends/requests/:id/accept` | `{}` | 204, empty body |
| DELETE `/api/friends/requests/:id` | `{}` | 204, empty body |
| DELETE `/api/friends/:friendUserId` | `{}` | 204, empty body |

`GET /api/users/:id` is a minimal authenticated public profile. It is distinct from
`GET /api/profile/me`, which returns private own-account information and statistics.
Search/public profile deliberately omit presence; only accepted friends see it.

Example friends response:

```json
{
  "items": [{
    "friendshipId": "<relationship-uuid>",
    "user": { "id": "<bob-uuid>", "username": "bob", "rating": 1200, "online": true },
    "acceptedAt": "2026-10-27T12:00:00.000Z"
  }],
  "hasMore": false, "offset": 0, "limit": 20
}
```

Example request item:

```json
{
  "id": "<request-uuid>",
  "direction": "incoming",
  "user": { "id": "<alice-uuid>", "username": "alice", "rating": 1200 },
  "createdAt": "2026-10-27T12:00:00.000Z"
}
```

Use **request ID** to accept/reject/cancel; use **friend's user ID** to unfriend.
The user in a request item is always the other participant. Dates are ISO UTC.

## Lifecycle and permissions

1. Alice sends a request to Bob. Alice sees outgoing, Bob sees incoming.
2. Only Bob can accept. The accepted relationship appears in both friends lists
   and disappears from pending requests.
3. Before acceptance, Alice may cancel and Bob may reject using the same DELETE.
4. Either participant can remove an accepted friendship.
5. Sending another request after rejection/cancellation/removal is allowed, subject
   to rate limits. A pending reverse request is NOT automatically accepted.

Self-requests return 400. Duplicate requests, crossed requests and requests between
existing friends return 409. Refresh lists and let the recipient explicitly accept.
Unknown/non-owned requests and invalid state transitions return 404. An already
accepted request cannot be deleted via the pending-request route. Repeated
unfriend returns 204 even if absent; it never deletes a pending request.
Concurrent acceptance/cancellation has exactly one winning conditional write.

## Errors and throttling

Errors use `{ error: { code, message, ... } }`. Use status/code for UI logic, render
messages as text, never HTML. The existing auth validation may include `fields`.

| Status | Meaning / frontend action |
|---|---|
| 400 | `INVALID_INPUT` or `SELF_REQUEST`; fix input |
| 401 | `UNAUTHENTICATED`; clear account state and return to login |
| 403 | `REQUEST_ORIGIN_REJECTED`; configuration/CSRF failure |
| 404 | `NOT_FOUND`; request/user missing, not owned, or changed state; refresh |
| 409 | `FRIENDSHIP_CONFLICT`; pending/accepted relationship already exists; refresh |
| 413 / 415 | Payload too large / JSON content type required |
| 429 | `RATE_LIMITED`; honor `Retry-After` in seconds |
| 503 | Storage/service unavailable or capacity reached; retry with backoff |

Limits: 180 friends/users HTTP requests per IP/minute; 120 reads and 30 mutations
per authenticated user/minute. Search counts as reads. Failed attempts may count.
Socket handshakes: 60 per transport IP/minute; 10 live friends sockets per user,
10,000 globally. Limit state is bounded and in-memory. With no trusted proxy IP
configured, Nginx clients share an IP limit. Set only the exact trusted proxy IP;
do not enable unrestricted proxy trust. These are initial single-instance limits.

Example request helper (to integrate into the frontend's existing API wrapper):

```ts
async function friendsApi(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`/api/${path}`, {
    method,
    credentials: 'same-origin',
    headers: method === 'GET' ? {} : {
      'Content-Type': 'application/json', 'X-CSRF-Protection': '1',
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
  });
  const data = response.status === 204 ? undefined : await response.json();
  if (!response.ok) {
    throw Object.assign(new Error(data?.error?.message ?? 'Request failed'), {
      status: response.status, code: data?.error?.code,
      retryAfter: response.headers.get('Retry-After'),
    });
  }
  return data;
}
```

## Realtime and online status

Frontend developer: add `socket.io-client` to the frontend's dependencies (the
backend currently includes it only as an integration-test dependency). Create a
single friends socket per authenticated browser tab in the global auth/application
layout, not only while displaying the Friends page. Remove listeners and disconnect
on logout/unmount. Do not change matchmaking's queue behavior.

```ts
import { io } from 'socket.io-client';

const socket = io('/friends', {
  path: '/socket.io',
  auth: { csrf: '1' },
  withCredentials: true,
  autoConnect: false,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 10000,
});
socket.on('friends:ready', refreshFriendsAndRequests);
socket.on('friends:changed', scheduleDebouncedRefresh);
socket.on('disconnect', markPresenceUnknown);
socket.on('connect_error', handleConnectionError);
socket.connect();
```

The cookie is sent automatically. No bearer token, arbitrary room subscription,
friend ID or user ID is accepted through this namespace. `friends:ready` and
`friends:changed` payloads are `{}`: they invalidate cached lists, not snapshots or
persistent notifications. Debounce/coalesce refreshes, and also refresh after your
own successful mutations, on reconnect and on window focus. Events are best-effort
and not replayed. Do not treat an invalidation as evidence of a particular change.

Connection errors use `FRIENDS_CONNECTION_REJECTED`. On error, check `/api/auth/me`:
if 401, go to login; otherwise back off and allow retry. Do not loop rapid reconnects.
Socket.IO middleware rejection may require an explicit `socket.connect()` retry.

`online` means at least one authenticated `/friends` connection is live. It does
not mean logged-in session exists in PostgreSQL, queued for matchmaking, or playing.
The legacy `users.status` column is not the source of friends presence.

- Multiple tabs/devices are counted separately.
- Closing one tab keeps the user online if another remains.
- After the last network disconnect, a 5-second grace period avoids flicker.
- Socket.IO detects dead connections through its heartbeat; grace starts after
  disconnect detection, not at the instant the network cable is removed.
- Logout/session rotation disconnects that session's live friends sockets
  immediately after the database commit. Other valid sessions stay connected.
- Expired/deleted sessions are checked on a 15-second sweep and before notifications;
  actual removal timing also depends on database latency and sweep duration.
- Database failures during revalidation disconnect affected sockets (fail closed).
- Backend restart clears presence; reconnect and refetch. Friendships persist.
- On your own connection loss, show stale presence as unknown/reconnecting rather
  than continuing to display old green dots as authoritative.

Only accepted friends receive presence-triggered invalidations. Search users,
pending request peers and removed friends do not receive another user's presence.
Request/relationship changes notify both participants so their lists refresh.

## UI checklist for the frontend teammate

- Friends navigation/page: accepted friends, incoming and outgoing sections.
- Debounced username search (minimum 3 characters); loading/empty/error states.
- Add/accept/reject/cancel/remove actions; disable action while pending.
- Minimal public profile using `/api/users/:id`; do not reuse own-profile data.
- Avatar initials fallback; no upload UI in this scope.
- Online indicator from friends API; unknown state when realtime disconnects.
- Pagination, 409/404 refresh, 401 login, 429 backoff, accessible buttons/feedback.
- Use fake data only in explicit frontend tests; real UI must consume these APIs.

## Verification and limitations

Backend tests:

```bash
cd backend
npm test
npm run test:bootstrap
# Use a disposable database ending in _test with the same restricted app role.
DATABASE_URL='<test database owner URL>' npm run prisma:migrate:deploy
TEST_DATABASE_URL='<test database app URL>' npm run test:friends:db
TEST_DATABASE_URL='<test database app URL>' npm run test:db
TEST_DATABASE_URL='<test database app URL>' npm run test:auth:db
```

Friendship tests cover lifecycle, privacy, raw-input/CSRF validation, unauthorized
operations, crossed requests, accept/cancel races, database constraints, account
cascade deletion, another application instance reading persisted friends, rate
limits, Socket.IO origin checks, multiple tabs, notifications, unfriend, logout
and expired-session disconnection. Presence unit tests cover grace and limits.

Manual end-to-end checks after frontend integration: two different users in two
browser profiles accept a request, observe each other online, open/close extra tabs,
log out, reconnect, remove friendship, and restart the backend. Confirm browser
HTTPS/WSS, no console errors, and no private fields in network responses.

Single backend instance only: presence, rate limits and lifecycle events are
in-memory; shared coordination is needed before horizontal scaling. Friends data
is durable. Blocking, game invitations, chat, avatars, last-seen timestamps and
in-game status are not implemented by this module. Docker/browser end-to-end
verification remains for the integrated frontend; the automated socket tests run
over local HTTP, not a browser TLS connection.

### Backend validation recorded 2026-10-27

Node 22.23.3 / isolated PostgreSQL 16.15: 39 default tests (37 auth + 2 presence),
4 friends integration scenarios, 20 schema/database tests, 2 auth/PostgreSQL
scenarios, bootstrap, ELO and both matchmaking suites passed. Build and tools
TypeScript checks passed. The frontend directory was not modified.
