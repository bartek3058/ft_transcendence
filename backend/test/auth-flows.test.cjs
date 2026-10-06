const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, sessionCookie, account } = require('./helpers/auth-harness.cjs');
const { hashSessionToken } = require('../dist/auth/session-cookie');
const { SessionService } = require('../dist/auth/session.service');

async function harness(t) {
  const h = await createHarness();
  t.after(() => h.app.close());
  return h;
}
async function register(h, input = account) {
  const response = await h.request('register', { method: 'POST', body: input });
  assert.equal(response.status, 201);
  return response;
}
const login = (h, body = { email: account.email, password: account.password }, cookie) =>
  h.request('login', { method: 'POST', body, cookie });

test('register → login → me → logout, with safe responses and hashed session storage', async (t) => {
  const h = await harness(t);
  const registration = await register(h);
  assert.equal(registration.headers.get('set-cookie'), null);
  const { user } = await registration.json();
  assert.deepEqual(Object.keys(user).sort(), ['createdAt', 'email', 'id', 'username']);
  assert.equal(user.email, 'alice@example.com');
  assert.equal(user.username, 'chess_fan');
  assert.match(h.repository.accounts.get(user.id).passwordHash, /^\$argon2id\$/);
  assert.equal((await h.request('me')).status, 401);
  const response = await login(h);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { user });
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, /^__Host-session=[A-Za-z0-9_-]{43};/);
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Expires=']) assert.ok(setCookie.includes(flag));
  assert.ok(!/Domain=/i.test(setCookie));
  const cookie = sessionCookie(response);
  const token = cookie.split('=')[1];
  const session = h.repository.sessions.get(hashSessionToken(token));
  assert.ok(session);
  assert.equal(session.expiresAt - session.createdAt, 604800000);
  assert.ok(!JSON.stringify([...h.repository.sessions.values()]).includes(token));
  const me = await h.request('me', { cookie });
  assert.equal(me.status, 200);
  assert.equal(me.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await me.json(), { user });
  assert.equal((await h.request('me', { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  const logout = await h.request('logout', { method: 'POST', cookie });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
  assert.equal(h.repository.sessions.size, 0);
  assert.equal((await h.request('me', { cookie })).status, 401);
  assert.equal((await h.request('logout', { method: 'POST', cookie })).status, 204);
});

test('duplicate identities map to 409, including racing registration requests', async (t) => {
  const h = await harness(t);
  const responses = await Promise.all([registerRequest(), registerRequest()]);
  function registerRequest() { return h.request('register', { method: 'POST', body: account }); }
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  assert.equal(h.repository.accounts.size, 1);
  const conflict = await h.request('register', { method: 'POST', body: { ...account, email: 'other@example.com' } });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'ACCOUNT_CONFLICT');
});

test('unknown account and wrong password have the same response and create no session', async (t) => {
  const h = await harness(t);
  await register(h);
  const wrong = await login(h, { email: account.email, password: account.password.trim() });
  const missing = await login(h, { email: 'missing@example.com', password: account.password });
  assert.equal(wrong.status, 401);
  assert.equal(missing.status, 401);
  assert.deepEqual(await wrong.json(), await missing.json());
  assert.equal(wrong.headers.get('set-cookie'), null);
  assert.equal(h.repository.sessions.size, 0);
});

test('login rotates only the current browser session; expired sessions fail before cleanup', async (t) => {
  const h = await harness(t);
  await register(h);
  const browserA = sessionCookie(await login(h));
  const browserB = sessionCookie(await login(h));
  const rotated = sessionCookie(await login(h, undefined, browserA));
  assert.notEqual(browserA, rotated);
  assert.equal((await h.request('me', { cookie: browserA })).status, 401);
  assert.equal((await h.request('me', { cookie: browserB })).status, 200);
  assert.equal((await h.request('me', { cookie: rotated })).status, 200);
  const session = h.repository.sessions.get(hashSessionToken(rotated.split('=')[1]));
  session.expiresAt = new Date(Date.now() - 1);
  assert.equal((await h.request('me', { cookie: rotated })).status, 401);
  assert.equal(h.repository.sessions.size, 2);
  await h.app.get(SessionService).cleanupExpired();
  assert.equal(h.repository.sessions.size, 1);
  assert.equal(h.repository.deletedBatches[0].limit, 500);
});

test('database failures do not leak data, issue cookies or report successful logout', async (t) => {
  const h = await harness(t);
  await register(h);
  const cookie = sessionCookie(await login(h));
  for (const [operation, path, method, body] of [
    ['createAccount', 'register', 'POST', { ...account, email: 'new@example.com', username: 'new_user' }],
    ['findAccount', 'login', 'POST', { email: account.email, password: account.password }],
    ['replaceSession', 'login', 'POST', { email: account.email, password: account.password }],
    ['findSession', 'me', 'GET', undefined],
    ['deleteSession', 'logout', 'POST', {}],
  ]) {
    h.repository.failure = operation;
    const response = await h.request(path, { method, body, cookie });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('set-cookie'), null);
    const result = await response.text();
    assert.ok(result.includes('AUTH_STORAGE_UNAVAILABLE'));
    assert.ok(!result.includes('PRIVATE_DETAILS'));
    assert.equal(h.repository.sessions.size, 1);
  }
  h.repository.failure = null;
  assert.equal((await h.request('me', { cookie })).status, 200);
});

test('missing/wrong origin or header prevents all mutations; logout validates empty body', async (t) => {
  const h = await harness(t);
  for (const path of ['register', 'login', 'logout']) {
    for (const headers of [{}, { Origin: 'https://evil.example', 'X-CSRF-Protection': '1' },
      { Origin: 'https://localhost' }, { Origin: 'https://localhost', 'X-CSRF-Protection': '0' },
      { Origin: 'null', 'X-CSRF-Protection': '1' }]) {
      const response = await h.request(path, { method: 'POST', body: account, csrf: false, headers });
      assert.equal(response.status, 403);
    }
  }
  assert.equal(h.repository.accounts.size, 0);
  for (const body of [[], null, 'text', { token: 'not-accepted' }]) {
    assert.equal((await h.request('logout', { method: 'POST', body })).status, 400);
  }
  assert.equal((await h.request('logout', { method: 'POST' })).status, 204);
});

test('login rate limit applies to normalized account and returns Retry-After', async (t) => {
  const h = await harness(t);
  for (let i = 0; i < 10; i++) {
    assert.equal((await login(h, { email: ' Missing@Example.com ', password: 'short' })).status, 401);
  }
  const denied = await login(h, { email: 'missing@example.com', password: 'short' });
  assert.equal(denied.status, 429);
  assert.ok(Number(denied.headers.get('retry-after')) > 0);
  assert.equal((await denied.json()).error.code, 'RATE_LIMITED');
});

test('malformed/duplicate cookies fail and untrusted forwarded IP cannot bypass limits', async (t) => {
  const h = await harness(t);
  await register(h);
  const cookie = sessionCookie(await login(h));
  for (const invalid of ['__Host-session=short', `${cookie}; ${cookie}`, '__Host-session=%00']) {
    assert.equal((await h.request('me', { cookie: invalid })).status, 401);
  }
  let denied;
  for (let i = 0; i < 65; i++) {
    denied = await h.request('me', { headers: { 'X-Forwarded-For': `192.0.2.${i + 1}` } });
    if (denied.status === 429) break;
    assert.equal(denied.status, 401);
  }
  assert.equal(denied.status, 429);
});

test('unrelated accounts remain isolated and session lookup never exposes password hashes', async (t) => {
  const h = await harness(t);
  await register(h);
  const second = { email: 'bob@example.com', username: 'bob_chess', password: 'another long password' };
  await register(h, second);
  const aliceCookie = sessionCookie(await login(h));
  const bobLogin = await login(h, { email: second.email, password: second.password });
  const bobCookie = sessionCookie(bobLogin);
  await h.request('logout', { method: 'POST', cookie: aliceCookie });
  const bob = await h.request('me', { cookie: bobCookie });
  assert.equal(bob.status, 200);
  const result = await bob.json();
  assert.equal(result.user.email, second.email);
  assert.ok(!JSON.stringify(result).includes('password'));
  assert.equal((await h.request('me', { cookie: aliceCookie })).status, 401);
});
