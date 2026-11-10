// PATCH /api/auth/me (username) and POST /api/auth/password over real HTTP with the
// real auth module. The repository is the in-memory double; SQL is in the Postgres test.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, sessionCookie, account } = require('./helpers/auth-harness.cjs');
const { hashSessionToken } = require('../dist/auth/session-cookie');
const { SessionService } = require('../dist/auth/session.service');

const NEW_PASSWORD = 'a brand new chess password';

async function loggedIn(t, input = account) {
  const h = await createHarness();
  t.after(() => h.app.close());
  assert.equal((await h.request('register', { method: 'POST', body: input })).status, 201);
  const login = await h.request('login', { method: 'POST', body: { email: input.email, password: input.password } });
  assert.equal(login.status, 200);
  return { ...h, cookie: sessionCookie(login), user: (await login.json()).user };
}

const rename = (h, username, cookie = h.cookie, options = {}) =>
  h.request('me', { method: 'PATCH', body: { username }, cookie, ...options });
const changePassword = (h, body, cookie = h.cookie, options = {}) =>
  h.request('password', { method: 'POST', body, cookie, ...options });
const errorCode = async (response) => (await response.json()).error.code;

test('username change keeps the case, shows up in /me and is a no-op for the same name', async (t) => {
  const h = await loggedIn(t);
  const response = await rename(h, '  Grand_Master ');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const { user } = await response.json();
  assert.deepEqual(user, { ...h.user, username: 'Grand_Master' });
  assert.deepEqual(await (await h.request('me', { cookie: h.cookie })).json(), { user });

  const same = await rename(h, 'Grand_Master');
  assert.equal(same.status, 200);
  assert.deepEqual(await same.json(), { user });
  // the session stays valid, renaming is not a re-login
  assert.equal((await h.request('me', { cookie: h.cookie })).status, 200);
});

test('a name that differs only in case from another user is taken', async (t) => {
  const h = await loggedIn(t);
  const other = { email: 'bob@example.com', username: 'Bobby', password: 'another long password' };
  assert.equal((await h.request('register', { method: 'POST', body: other })).status, 201);
  for (const name of ['bobby', 'BOBBY', 'Bobby']) {
    const response = await rename(h, name);
    assert.equal(response.status, 409);
    assert.equal(await errorCode(response), 'USERNAME_TAKEN');
  }
  // registering a case variant of an existing name is rejected too
  const clash = await h.request('register', { method: 'POST',
    body: { ...other, email: 'bob2@example.com', username: 'BoBbY' } });
  assert.equal(clash.status, 409);
  // changing only the case of your own name is fine
  assert.equal((await rename(h, 'CHESS_FAN')).status, 200);
});

test('username change validates the body without echoing it', async (t) => {
  const h = await loggedIn(t);
  for (const username of ['ab', 'a'.repeat(21), 'bad-name', 'with space', 'ünïcode', '']) {
    const response = await rename(h, username);
    assert.equal(response.status, 400, username);
    assert.equal(await errorCode(response), 'INVALID_INPUT');
  }
  for (const body of [{}, { username: 123 }, { username: 'Fine_Name', role: 'admin' }, { username: ['x'] }]) {
    const response = await h.request('me', { method: 'PATCH', body, cookie: h.cookie });
    assert.equal(response.status, 400);
    assert.ok(!JSON.stringify(await response.json()).includes('admin'));
  }
  assert.equal(h.repository.accounts.get(h.user.id).username, account.username);
});

test('origin/CSRF is checked before the session, the session before the body', async (t) => {
  const h = await loggedIn(t);
  let lookups = 0;
  const findSession = h.repository.findSession.bind(h.repository);
  h.repository.findSession = (hash) => { lookups++; return findSession(hash); };

  for (const [path, method, body] of [['me', 'PATCH', { username: 'Csrf_Name' }],
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
  assert.equal(h.repository.accounts.get(h.user.id).username, account.username);
});

test('username changes are limited per user (sliding window, Retry-After)', async (t) => {
  const h = await loggedIn(t);
  for (let i = 0; i < 5; i++) assert.equal((await rename(h, `Name_${i}`)).status, 200);
  const limited = await rename(h, 'Name_5');
  assert.equal(limited.status, 429);
  assert.equal(await errorCode(limited), 'RATE_LIMITED');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal(h.repository.accounts.get(h.user.id).username, 'Name_4');
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
  h.repository.failure = 'updateUsername';
  const renameFail = await rename(h, 'Other_Name');
  assert.equal(renameFail.status, 503);
  assert.ok(!JSON.stringify(await renameFail.json()).includes('PRIVATE_DETAILS'));
  h.repository.failure = 'changePassword';
  const passwordFail = await changePassword(h, { currentPassword: account.password, newPassword: NEW_PASSWORD });
  assert.equal(passwordFail.status, 503);
  assert.equal(passwordFail.headers.get('set-cookie'), null);
  assert.ok(!JSON.stringify(await passwordFail.json()).includes('PRIVATE_DETAILS'));
});
