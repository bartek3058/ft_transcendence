// PATCH /api/auth/me (display name) and POST /api/auth/password over real HTTP with the
// real auth module. The repository is the in-memory double; SQL is in the Postgres test.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, sessionCookie, account } = require('./helpers/auth-harness.cjs');
const { hashSessionToken } = require('../dist/auth/session-cookie');
const { SessionService } = require('../dist/auth/session.service');

const NEW_PASSWORD = 'a brand new chess password';
const BOB = { email: 'bob@example.com', username: 'bobby', password: 'another long password' };

async function loggedIn(t, input = account) {
  const h = await createHarness();
  t.after(() => h.app.close());
  assert.equal((await h.request('register', { method: 'POST', body: input })).status, 201);
  const login = await h.request('login', { method: 'POST', body: { email: input.email, password: input.password } });
  assert.equal(login.status, 200);
  return { ...h, cookie: sessionCookie(login), user: (await login.json()).user };
}

const setName = (h, displayName, cookie = h.cookie, options = {}) =>
  h.request('me', { method: 'PATCH', body: { displayName }, cookie, ...options });
const changePassword = (h, body, cookie = h.cookie, options = {}) =>
  h.request('password', { method: 'POST', body, cookie, ...options });
const errorCode = async (response) => (await response.json()).error.code;

test('display name: set, shown in /me, normalized, and cleared with ""', async (t) => {
  const h = await loggedIn(t);
  assert.equal(h.user.displayName, null);
  const response = await setName(h, '  Grand   Master ♞ ');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const { user } = await response.json();
  assert.deepEqual(user, { ...h.user, displayName: 'Grand Master ♞' });
  assert.deepEqual(await (await h.request('me', { cookie: h.cookie })).json(), { user });
  // the username never changes
  assert.equal(h.repository.accounts.get(h.user.id).username, h.user.username);

  const cleared = await setName(h, '');
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).user.displayName, null);
  assert.equal(h.repository.accounts.get(h.user.id).displayNameKey, null);
});

test('display names are unique ignoring case and look-alike forms', async (t) => {
  const h = await loggedIn(t);
  assert.equal((await h.request('register', { method: 'POST', body: BOB })).status, 201);
  const bob = sessionCookie(await h.request('login', { method: 'POST', body: { email: BOB.email, password: BOB.password } }));
  assert.equal((await setName(h, 'Émile ♞', bob)).status, 200);
  for (const name of ['Émile ♞', 'ÉMILE ♞', 'émile ♞']) {
    const response = await setName(h, name);
    assert.equal(response.status, 409, name);
    assert.equal(await errorCode(response), 'DISPLAY_NAME_TAKEN');
  }
  // once Bob clears it, the name is free again
  assert.equal((await setName(h, '', bob)).status, 200);
  assert.equal((await setName(h, 'émile ♞')).status, 200);
});

test('a display name can\'t impersonate another user\'s username, and the reverse', async (t) => {
  const h = await loggedIn(t);
  assert.equal((await h.request('register', { method: 'POST', body: BOB })).status, 201);
  for (const name of ['bobby', 'BOBBY', 'Ｂｏｂｂｙ']) {
    const response = await setName(h, name);
    assert.equal(response.status, 409, name);
    assert.equal(await errorCode(response), 'DISPLAY_NAME_TAKEN');
  }
  // your own username in another case is fine
  assert.equal((await setName(h, account.username.toUpperCase())).status, 200);

  // a new account can't register a username someone already shows as display name
  assert.equal((await setName(h, 'Carol')).status, 200);
  const carol = await h.request('register', { method: 'POST',
    body: { email: 'carol@example.com', username: 'carol', password: 'carol long password' } });
  assert.equal(carol.status, 409);
});

test('display name input is validated without echoing it', async (t) => {
  const h = await loggedIn(t);
  for (const displayName of ['ab', 'x'.repeat(21), 'ab​cd', 'ab‮cd', '♞♞♞', 'tab\there']) {
    const response = await setName(h, displayName);
    assert.equal(response.status, 400, JSON.stringify(displayName));
    assert.equal(await errorCode(response), 'INVALID_INPUT');
  }
  for (const body of [{}, { displayName: null }, { displayName: 5 }, { displayName: 'Fine Name', username: 'admin' }]) {
    const response = await h.request('me', { method: 'PATCH', body, cookie: h.cookie });
    assert.equal(response.status, 400);
    assert.ok(!JSON.stringify(await response.json()).includes('admin'));
  }
  assert.equal(h.repository.accounts.get(h.user.id).displayName, null);
});

test('origin/CSRF is checked before the session, the session before the body', async (t) => {
  const h = await loggedIn(t);
  let lookups = 0;
  const findSession = h.repository.findSession.bind(h.repository);
  h.repository.findSession = (hash) => { lookups++; return findSession(hash); };

  for (const [path, method, body] of [['me', 'PATCH', { displayName: 'Csrf Name' }],
    ['password', 'POST', { currentPassword: account.password, newPassword: NEW_PASSWORD }]]) {
    const noCsrf = await h.request(path, { method, body, cookie: h.cookie, csrf: false });
    assert.equal(noCsrf.status, 403);
    assert.equal(await errorCode(noCsrf), 'REQUEST_ORIGIN_REJECTED');
    const wrongOrigin = await h.request(path, { method, body, cookie: h.cookie,
      headers: { Origin: 'https://evil.example' } });
    assert.equal(wrongOrigin.status, 403);
    assert.equal(lookups, 0);

    const noSession = await h.request(path, { method, body: { junk: true } });
    assert.equal(noSession.status, 401);
  }
  assert.equal(h.repository.accounts.get(h.user.id).displayName, null);
});

test('display name changes are limited per user (sliding window, Retry-After)', async (t) => {
  const h = await loggedIn(t);
  for (let i = 0; i < 5; i++) assert.equal((await setName(h, `Name ${i}`)).status, 200);
  const limited = await setName(h, 'Name 5');
  assert.equal(limited.status, 429);
  assert.equal(await errorCode(limited), 'RATE_LIMITED');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal(h.repository.accounts.get(h.user.id).displayName, 'Name 4');
});

test('password change: new cookie, every other session revoked, only the new password works', async (t) => {
  const h = await loggedIn(t);
  const secondDevice = sessionCookie(await h.request('login', { method: 'POST',
    body: { email: account.email, password: account.password } }));
  const revoked = [];
  h.app.get(SessionService).revocations.on('revoked', (hash) => revoked.push(hash));
  const oldHash = h.repository.accounts.get(h.user.id).passwordHash;

  const response = await changePassword(h, { currentPassword: account.password, newPassword: NEW_PASSWORD });
  assert.equal(response.status, 204);
  const fresh = sessionCookie(response);
  assert.match(fresh, /^__Host-session=[A-Za-z0-9_-]{43}$/);
  assert.notEqual(fresh, h.cookie);
  assert.match(h.repository.accounts.get(h.user.id).passwordHash, /^\$argon2id\$/);
  assert.notEqual(h.repository.accounts.get(h.user.id).passwordHash, oldHash);

  assert.equal((await h.request('me', { cookie: fresh })).status, 200);
  assert.equal((await h.request('me', { cookie: h.cookie })).status, 401);
  assert.equal((await h.request('me', { cookie: secondDevice })).status, 401);
  assert.deepEqual(revoked.sort(), [h.cookie, secondDevice].map((c) => hashSessionToken(c.split('=')[1])).sort());
  assert.equal(h.repository.sessions.size, 1);

  const oldLogin = await h.request('login', { method: 'POST', body: { email: account.email, password: account.password } });
  assert.equal(oldLogin.status, 401);
  const newLogin = await h.request('login', { method: 'POST', body: { email: account.email, password: NEW_PASSWORD } });
  assert.equal(newLogin.status, 200);
});

test('wrong or unchanged current password changes nothing and keeps the session', async (t) => {
  const h = await loggedIn(t);
  const before = h.repository.accounts.get(h.user.id).passwordHash;
  const sessions = h.repository.sessions.size;

  const wrong = await changePassword(h, { currentPassword: 'not my password at all', newPassword: NEW_PASSWORD });
  assert.equal(wrong.status, 400);
  assert.equal(await errorCode(wrong), 'INVALID_CURRENT_PASSWORD');
  assert.equal(wrong.headers.get('set-cookie'), null);

  const same = await changePassword(h, { currentPassword: account.password, newPassword: account.password });
  assert.equal(same.status, 400);
  assert.equal(await errorCode(same), 'PASSWORD_UNCHANGED');

  const short = await changePassword(h, { currentPassword: account.password, newPassword: 'too short' });
  assert.equal(short.status, 400);
  assert.equal(await errorCode(short), 'INVALID_INPUT');

  const extra = await changePassword(h, { currentPassword: account.password, newPassword: NEW_PASSWORD, userId: 'x' });
  assert.equal(extra.status, 400);

  assert.equal(h.repository.accounts.get(h.user.id).passwordHash, before);
  assert.equal(h.repository.sessions.size, sessions);
  assert.equal((await h.request('me', { cookie: h.cookie })).status, 200);
});

test('a password changed in the meantime gives 409 and keeps the newer hash', async (t) => {
  const h = await loggedIn(t);
  const changePasswordInRepo = h.repository.changePassword.bind(h.repository);
  // another request swaps the hash between our verify and our write
  h.repository.changePassword = async (...args) => {
    h.repository.accounts.get(h.user.id).passwordHash = '$argon2id$changed-elsewhere';
    return changePasswordInRepo(...args);
  };
  const response = await changePassword(h, { currentPassword: account.password, newPassword: NEW_PASSWORD });
  assert.equal(response.status, 409);
  assert.equal(await errorCode(response), 'PASSWORD_CHANGED_CONCURRENTLY');
  assert.equal(h.repository.accounts.get(h.user.id).passwordHash, '$argon2id$changed-elsewhere');
  assert.equal(response.headers.get('set-cookie'), null);
});

test('password attempts are limited per user, wrong guesses included', async (t) => {
  const h = await loggedIn(t);
  for (let i = 0; i < 5; i++) {
    const response = await changePassword(h, { currentPassword: `wrong guess number ${i}`, newPassword: NEW_PASSWORD });
    assert.equal(response.status, 400);
  }
  const limited = await changePassword(h, { currentPassword: account.password, newPassword: NEW_PASSWORD });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal((await h.request('me', { cookie: h.cookie })).status, 200);
});

test('storage failures return 503 without leaking driver details', async (t) => {
  const h = await loggedIn(t);
  h.repository.failure = 'updateDisplayName';
  const nameFail = await setName(h, 'Other Name');
  assert.equal(nameFail.status, 503);
  assert.ok(!JSON.stringify(await nameFail.json()).includes('PRIVATE_DETAILS'));
  h.repository.failure = 'changePassword';
  const passwordFail = await changePassword(h, { currentPassword: account.password, newPassword: NEW_PASSWORD });
  assert.equal(passwordFail.status, 503);
  assert.equal(passwordFail.headers.get('set-cookie'), null);
  assert.ok(!JSON.stringify(await passwordFail.json()).includes('PRIVATE_DETAILS'));
});
