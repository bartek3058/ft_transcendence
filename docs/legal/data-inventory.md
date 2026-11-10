# Data inventory — git_privacy

Reviewed 2026-11-09. Repository evidence, not verification of deployed hosting.

| Area | Data / purpose | Evidence | Unresolved |
|---|---|---|---|
| Accounts | Email, username, password hash, role, rating and timestamps; authentication/profile | backend/prisma/schema.prisma, backend/src/auth | Operator confirmed: Tomasz Szymański; manual deletion implementation to verify |
| Sessions | Hashed token, account ID, creation/expiry; authentication | backend/src/auth/session.service.ts, auth.config.ts, session-cookie.ts | Actual deployed TTL; backup lifecycle |
| Friends | Pair IDs, requester, status, dates; relationship management | backend/src/friends, Prisma Friendship | Retention after account removal |
| Presence | Socket connections and temporary reconnect grace; friend online indicators | backend/src/friends/presence.service.ts | Confirm deployment topology |
| Chess records | Game IDs, players, moves, results, rating snapshots, PGN and times supported by schema | backend/prisma/schema.prisma, backend/src/game | Which gameplay persistence paths work; history retention |
| Public profiles | Username and rating, friend online status | backend/src/friends/friends.service.ts | Confirm any other endpoint exposure before publication |
| Connections/logs | IP address forwarded by nginx; errors and request limits | nginx/nginx.conf, backend/src/auth | Local computer; enforce seven-day logs/backups and restrict administrator access |
| AI chat | Messages, bounded history, FEN/moves sent to configurable LLM; moderation may use it too | backend/src/chat | Provider, countries, retention and transfer safeguards |
| Tournaments | Participants, invitations, seeds, check-ins, brackets/results | backend/src/tournament, Prisma | Retention and public visibility |
| Public API | Key-owner/hash/lifecycle metadata; selected game/player stats | backend/src/public-api, Prisma ApiKey | Actual clients and deployment policy |
| Browser storage | Last game ID per user in sessionStorage | frontend/src/hooks/useMatchmaking.ts | Verify deployed client behavior |
| Player chat | Local demonstration, not persisted private messages | frontend/src/hooks/useChat.ts | Update before implementing real messaging |

AI and tournament modules are present in this copy. Document legal bases purpose by purpose once the actual operator/deployment is known. Keep credentials out of this inventory.

## Agreed retention schedule

Accounts, friendships, games, tournaments and API-key records: during development/evaluation, then delete within 30 days after final evaluation, or earlier on an applicable deletion request. Logs: at most seven days. Backups, if made: rolling seven days and final cleanup. AI conversations: browser memory only by policy; verify log redaction. Gemini retention is separate and service-specific. See the operator checklist for implementation tasks.
