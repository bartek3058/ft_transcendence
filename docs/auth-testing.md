# Registration and login testing

The backend now uses `PrismaAuthRepository`. Registration creates a real user;
login stores a SHA-256 hash of a random session token. The raw token is returned
only through the Secure, HttpOnly `__Host-session` cookie. Registration does not
automatically log in.

## Automated checks

Use Node 22. From `backend`:

```bash
npm ci
npm run prisma:generate
npm test
npm run test:bootstrap
```

Provision a disposable PostgreSQL database ending in `_test`, apply the same
role grants as the main database, and migrate it using the owner role. Then run
both suites with restricted application credentials:

```bash
DATABASE_URL='<owner URL for chess_auth_test>' npm run prisma:migrate:deploy
TEST_DATABASE_URL='<application URL for chess_auth_test>' npm run test:db
TEST_DATABASE_URL='<application URL for chess_auth_test>' npm run test:auth:db
```

Both suites reject a missing TEST_DATABASE_URL or a database name without the
`_test` suffix. Do not use a database containing real data. The authentication
suite runs the real AppModule, uses temporary local HTTP ports, and removes its
created users/sessions. It checks:

- Registration normalization, Argon2id storage and safe response fields.
- Duplicate email/username rejection, including concurrent database inserts.
- Wrong-password and unknown-account failures without session creation.
- Login cookies, hashed session storage and authenticated `/me`.
- Session persistence across a Nest application shutdown and recreation.
- Rotation, expiration, logout and repeated logout.
- Failed replacement rollback, safe session projections and bounded cleanup.
- Application-role denial of table creation.

These server tests manually send cookies over loopback HTTP. They do not prove
browser Secure-cookie behavior or Docker/Nginx deployment correctness.

## Manual HTTPS check

From the project root, create `.env` from `.env.example` if it does not exist.
For an existing `.env`, add the new database keys without overwriting your values.
Set distinct owner/application secrets and matching connection URLs (URL-encode
passwords in URLs). Leave ADMIN_PASSWORD empty unless you want an initial admin.
Keep APP_ORIGIN=https://localhost for this check.

```bash
docker compose up --build -d
docker compose ps -a
docker compose logs migration backend
```

The migration service should exit successfully and the backend should start.
Open `https://localhost` using a trusted local certificate. The frontend does not
yet provide auth forms; use the browser developer console on that origin:

```js
async function authRequest(route, body) {
  const response = await fetch(`/api/auth/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? {} : {
      'Content-Type': 'application/json', 'X-CSRF-Protection': '1',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status,
    data: response.status === 204 ? null : await response.json() };
}
const suffix = Date.now().toString(36);
const account = { email: `tester_${suffix}@example.com`, username: `tester_${suffix}`,
  password: 'A local chess test password!42' };
await authRequest('register', account); // 201, safe user fields
await authRequest('register', account); // 409 duplicate account
await authRequest('login', { email: account.email, password: 'incorrect password' }); // 401
await authRequest('login', { email: account.email, password: account.password }); // 200
await authRequest('me'); // 200
await authRequest('logout', {}); // 204
await authRequest('me'); // 401
```

The browser supplies Origin automatically. Verify cookie flags in developer tools:
Secure, HttpOnly, SameSite=Lax, Path=/, no Domain. JavaScript must not be able to read
the session cookie. A page reload after login should preserve authentication.
These manual accounts remain in your local development database.

## Validation recorded on 2026-10-11

Node 22.23.3 and isolated PostgreSQL 16.15: 37 existing auth tests, 20 database
checks and 2 real-database integration scenarios passed. The integration scenarios
contain the assertions listed above. Docker/Nginx and browser verification remain
pending because Docker is unavailable in this workspace.

## Merge verification — 2026-10-13

Authentication and database fixes were integrated into
`ft_transcendence-pjedrycz-registration-login`. The main branch frontend, game
code, Prisma schema and SQL migration were preserved. The backend Dockerfile
generates Prisma at build time; the retained legacy docker-entrypoint.sh is not
used by that Dockerfile.

Verified in this folder on Node 22.23.3 and PostgreSQL 16.15: 37 auth tests,
5 bootstrap tests, 20 database checks and 2 database-backed integration scenarios
passed. Build and TypeScript checks also passed. Docker/browser verification
remains pending. The isolated PostgreSQL test server was stopped afterward.
