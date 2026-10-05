# Registration/login input and API contract

Status: implementation specification, 2026-10-04. DTOs, backend validation/JSON limits and password hashing are implemented in [stage 1](auth-stage-one.md). Endpoints, sessions, CSRF, throttling, proxy limits and frontend validation remain planned. Applies to NestJS/Express, React and the [database handoff](auth-database-handoff.md).

## 1. Normalize only what the product defines

Normalization chooses a canonical identity. Validation accepts/rejects a value. Output encoding depends on where a value is rendered. A generic “sanitize every string” function is not a safe substitute for these separate steps.

| Field | Normalization | Validation |
|---|---|---|
| email | Trim surrounding whitespace, then lowercase ASCII letters. Same function for register and login. | Must already be a string; conventional ASCII email syntax, one address, no display name, no internal whitespace, total length ≤254 and local part ≤64. Use a maintained validator rather than a handwritten email regex. |
| username | Trim surrounding whitespace, then lowercase ASCII letters. | Registration only: `[a-z0-9_]{3,20}`. Clearly tell users their public handle will be lowercase. |
| password | **None:** no trim, lowercase, Unicode normalization, HTML escaping or character removal. | Registration: 15–128 Unicode code points, max 512 UTF-8 bytes. Allow spaces, punctuation and Unicode; reject malformed Unicode (unpaired surrogate code units) rather than silently changing it. Login: nonempty and same upper bounds; do not reapply a newer registration minimum to existing accounts. |

These exact limits are project policies, not numeric requirements in the subject. The 15-character minimum is selected for password-only login without MFA. No mandatory uppercase/digit/symbol composition rules. Count Unicode code points consistently on both sides (for example, `Array.from(value).length` after well-formed-Unicode validation); HTML maxlength counts UTF-16 units and must not be the only check. Bounds are rejection limits, never truncation. A future Unicode-normalization change for passwords would require an explicit credential migration strategy.

Email normalization does not remove dots, strip `+tags`, infer mailbox ownership or convert internationalized local parts. Syntax validation does not verify that an address exists; email verification and password recovery are separate future features. Users must be told that passwords containing leading/trailing spaces retain those spaces.

Examples:

| Input | Result |
|---|---|
| email ` Alice@Example.COM ` | `alice@example.com` on registration and login |
| email `alice+chess@example.com` | Keep `+chess` |
| username ` Chess_Fan ` | `chess_fan` |
| username `<b>alice</b>` | Reject; do not strip tags and quietly create `alice` |
| password `  my long passphrase!  ` | Hash and verify the exact value, including spaces |
| email `null`, `123`, array or object | Reject; do not coerce to text |

## 2. NestJS request handling

Use explicit register/login DTOs with class-validator/class-transformer versions compatible with the existing NestJS major. Global ValidationPipe configuration: `whitelist: true`, `forbidNonWhitelisted: true`, `forbidUnknownValues: true`, `transform: true`, implicit type conversion disabled. Disable validation error target/value exposure. Type-check before string transforms; no `String(value)` coercion. Reject null/array/scalar request bodies. Set explicit maximum lengths and custom validators where built-in length semantics do not match the contract.

Accept JSON only for these endpoints. Impose a 16 KiB JSON body limit before expensive validation/hashing, initially at the backend and consistently at the proxy; future avatar upload limits belong on separate routes. Return a controlled 400 for malformed JSON, 413 for oversized bodies, and 415 for unsupported media types. Confirm the parser ordering in NestJS/Express so the default parser does not bypass the chosen limit.

Reject extra fields such as `id`, `role`, `rating`, `passwordHash`, `emailVerified` or `session`; they must never be mass-assigned to database records. Return only known, safe validation codes/messages, never rejected password values. Do not log request bodies, Cookie/Set-Cookie headers, or raw tokens.

Browser form validation uses the same rules for immediate feedback. Backend validation remains mandatory because clients can bypass the form. A confirm-password field can exist in the UI only; the API accepts a single password field. Do not send confirmPassword as an unexpected API property.

## 3. Sanitization does not prevent every injection

- SQL: use parameterized Prisma operations. Do not remove apostrophes from passwords or build SQL by concatenating strings.
- HTML: render usernames/errors through ordinary React text interpolation. Do not use dangerouslySetInnerHTML for account data. Encode for the actual output context rather than storing HTML-escaped text in the database.
- Email: do not copy unchecked user input into mail headers if email delivery is added later.
- Authentication: hashing, sessions, CSRF protection and rate limits remain necessary even when all input passes validation.

For browser mutations, deploy frontend/API on the same HTTPS origin, check Origin against configured APP_ORIGIN, require JSON and an explicit custom request header (proposed `X-CSRF-Protection: 1`), and do not permit cross-origin credentialed requests. Apply this to register/login/logout, including login CSRF. The header value is not a secret token: the defense relies on browser preflight restrictions plus origin validation and SameSite cookies. Reject missing/mismatched Origin under this browser-only contract; command-line test clients must supply the configured Origin/header. If cross-origin clients or non-JSON mutations are added, revisit this policy rather than weakening it ad hoc.

Rate-limit before password hashing with per-IP and per-canonical-account limits and bounded storage; configure proxy trust narrowly so forged X-Forwarded-For cannot bypass limits. Return 429 and Retry-After when limited; avoid permanent account lockout. Benchmark Argon2id parameters and bound concurrent hashing. Unknown-email login should perform verification against a fixed dummy hash using the same cost as real users. Do not claim perfect timing equality.

## 4. Endpoint contract

All routes below use `/api/auth`. Responses set Cache-Control: no-store. Error envelope: `{ "error": { "code": "...", "message": "...", "fields": [] } }`; omit fields if inapplicable. Field errors contain field names and safe codes, not submitted values.

| Route | JSON body | Success | Expected errors |
|---|---|---|---|
| POST /register | `{email, username, password}` | 201 `{user: {id, email, username, createdAt}}`; no login cookie | 400 invalid input, 409 ACCOUNT_CONFLICT, 429 throttled |
| POST /login | `{email, password}` | 200 same user shape; Set-Cookie creates/replaces current browser session | 400 malformed input, 401 INVALID_CREDENTIALS, 429 throttled |
| GET /me | None | 200 same user shape using cookie session | 401 UNAUTHENTICATED |
| POST /logout | Empty JSON object `{}` | 204, revoke current session and expire cookie; idempotent if already absent | 403 origin/header rejection |

Mutation routes can also return 403 for CSRF/origin failures, 413/415 for request format limits, and controlled service errors for unavailable persistence. Do not mislabel a DB outage as invalid credentials or report logout success when an existing session could not be revoked. No password/hash/token appears in a JSON response. Email is private to the authenticated owner response, not a future public profile endpoint.

## 5. Required tests before calling auth complete

- Same canonical email/username collide after trimming/case normalization, including concurrent registrations.
- Invalid types, unknown properties, malformed JSON and oversized bodies are rejected before persistence/hashing.
- Exact Unicode/space-containing password works; altered/truncated/trimmed password fails. Length boundaries use code points; malformed surrogate sequences are rejected.
- HTML-looking username fails validation; quotes in a valid password remain intact and do not affect SQL.
- Missing account and wrong password produce the same public login error; credentials do not appear in logs/responses.
- Session cookie flags, token-hash-only storage, expiration, fresh login token, logout/revocation and multiple-browser independence work.
- Missing/foreign Origin and missing custom header fail mutation requests; GET /me has no state-changing action.
- Rate limits apply behind the proxy; safe error handling works when PostgreSQL is unavailable.
- Real PostgreSQL integration tests and trusted HTTPS browser tests pass, not only mock/unit tests.

## References

- [OWASP input validation](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html)
- [OWASP authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [OWASP CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
- [NestJS validation](https://docs.nestjs.com/techniques/validation): use the class-validator ValidationPipe API compatible with NestJS 10; newer documentation may also describe newer APIs.
