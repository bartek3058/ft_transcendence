# Authentication stage 1: input and password handling

Implemented 2026-10-04. This stage is database-independent and introduces no registration/login HTTP endpoints. It prepares the building blocks for the next stage: persisted accounts and sessions.

## Read the code in this order

1. [Input rules](../backend/src/auth/validation/input-rules.ts): email/handle normalization and exact password bounds. ASCII-only case conversion prevents Unicode characters from unexpectedly turning into valid ASCII handles. Passwords are never normalized.
2. [Login DTO](../backend/src/auth/dto/login.dto.ts) and [register DTO](../backend/src/auth/dto/register.dto.ts): input shapes with runtime validators. Registration inherits email validation and overrides the minimum password length to 15 code points; login keeps a minimum of one for existing accounts.
3. [Validation pipe](../backend/src/auth/validation/auth-validation.pipe.ts): rejects wrong body types, unexpected keys and nested/non-string field values before transformation. Errors contain safe field names/codes, not submitted values.
4. [Password service](../backend/src/auth/password.service.ts): Argon2id hashing and verification. The hash contains its salt/parameters. Missing-account verification uses a dummy hash initialized once at startup. Invalid stored hashes propagate as internal errors, not ordinary wrong-password responses.
5. [Application configuration](../backend/src/configure-app.ts): the single 16 KiB JSON parser, safe malformed/oversized JSON responses, auth JSON-only policy and global validation pipe. Main disables Nest's default parser to avoid a second parser bypassing that limit.
6. [Auth module](../backend/src/auth/auth.module.ts): registers/exports PasswordService for future auth orchestration. It has no controller yet.

Future controller flow:

```text
JSON parser → origin/rate-limit guards → DTO validation → auth service
                                                       ├─ PasswordService
                                                       └─ database-backed users/sessions
```

The guards and database operations in this diagram are not implemented in this stage. Keeping the auth routes unregistered prevents these foundations from being mistaken for usable account endpoints.

## Running checks

Use Node 22 (tested/pinned in `.nvmrc` and backend Dockerfile at 22.23.3). From `backend/`:

```sh
npm ci
npm test
```

`npm test` builds the project and runs Node's built-in test runner. The 24 tests cover DTO boundaries, normalization, special/Unicode passwords, prototype-related input, error redaction, hashing/salts, dummy verification, bounded hash concurrency, actual HTTP parser/validation behavior and the existing health endpoint. HTTP tests create a temporary loopback listener and close it afterward. Their controller exists only in the test file; it is not registered in production. These internal harness tests do not substitute for deployment HTTPS tests.

Nest deletes `dist` before builds; TypeScript incremental compilation was disabled because the old cache could otherwise skip emitting files after deletion. A backend lockfile and `npm ci` replace unlocked backend Docker installs. `.dockerignore` prevents local node_modules/build output/secrets from entering that image. The frontend toolchain was not changed.

## Password cost and resource limits

Current settings: Argon2id, 64 MiB memory, three iterations, one lane, 32-byte hash, library-generated random salt. The singleton permits at most two concurrent hash/verify operations (roughly 128 MiB for Argon2 working memory, in addition to app/runtime overhead), with no unbounded waiting queue. Saturation returns 503 AUTH_BUSY. Benchmark on the evaluation machine before deployment; this bound does not replace per-IP/account throttling. The later route layer should add appropriate Retry-After behavior.

`verify(password, null)` is the missing-account path. A real record must provide the encoded stored hash. Never return it in public user responses. Startup initializes the dummy hash before Nest begins serving requests.

## Remaining integration work

- Database teammate supplies the [database handoff](auth-database-handoff.md): schema, migrations and shared provider.
- Add account/session services and the register/login/me/logout controller. Store only session-token hashes; return safe user DTOs.
- Add origin/custom-header CSRF checks, per-IP/account rate limits and narrow proxy trust before exposing those routes. Removing permissive CORS alone is not CSRF protection.
- Implement cookies, absolute expiry/revocation, cleanup and controlled persistence failures.
- Apply a matching proxy body limit and test trusted HTTPS/certificates. Docker is unavailable in the current implementation environment, so the updated Dockerfile has not been built here.
- Add frontend forms using the same validation rules. Backend DTOs do not complete the subject's frontend-validation requirement.
- Run PostgreSQL race/persistence tests and browser HTTPS tests once those components exist.

## Dependency audit follow-up

Installation and a compatible audit-fix pass exposed advisories in the inherited NestJS 10/framework tooling tree. Updating the direct Express dependency to 4.22.3 reduced the reported total to 22 (4 low, 8 moderate, 10 high); audit counts can change as advisories change. Several remaining fixes require major framework/toolchain changes according to npm. This is not a clean security audit or a deployment-ready auth system. Plan a coordinated NestJS dependency update before deployment; do not blindly run `npm audit fix --force` in a shared branch. Re-run `npm audit` against the committed lockfile when reviewing that update.

## AI assistance

An AI coding assistant drafted these DTOs, validation/parser configuration, password service, tests and documentation. The team should review the decisions, explain the code and verify integration before claiming the functionality in evaluation. No database/user data was supplied to this work.
