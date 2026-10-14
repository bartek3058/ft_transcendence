require('reflect-metadata');
require('ts-node').register({ project: 'tsconfig.tools.json' });
const { requireTestDatabaseUrl } = require('../test-database-url.ts');
process.env.DATABASE_URL = requireTestDatabaseUrl(process.env.TEST_DATABASE_URL);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../../dist/app.module');
const { configureApp } = require('../../dist/configure-app');
const { PrismaService } = require('../../dist/database/prisma.service');
const { AuthRepository, AccountConflictError } = require('../../dist/auth/auth.repository');
const { hashSessionToken } = require('../../dist/auth/session-cookie');
const { AUTH_CONFIG } = require('../../dist/auth/auth.config');
const argon2 = require('argon2');

async function start() {
  const app = await NestFactory.create(AppModule, { bodyParser: false, logger: false, abortOnError: false });
  try {
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const origin = app.get(AUTH_CONFIG).origin;
    const request = (route, method = 'GET', body, cookie) => fetch(`${base}/api/auth/${route}`, {
      method, headers: { 'Content-Type': 'application/json', Origin: origin,
        'X-CSRF-Protection': '1', ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { app, request, db: app.get(PrismaService), repo: app.get(AuthRepository) };
  } catch (error) { await app.close(); throw error; }
}
const cookieOf = response => response.headers.get('set-cookie')?.split(';')[0];
const hashOf = cookie => hashSessionToken(cookie.slice(cookie.indexOf('=') + 1));

test('real application: registration, login, persistence, rotation, expiry and logout', async t => {
  let h = await start();
  const ids = [];
  t.after(async () => {
    try { await h.db.user.deleteMany({ where: { id: { in: ids } } }); }
    finally { await h.app.close(); }
  });
  // Running the suite as the owner must fail, even though CRUD would work.
  await assert.rejects(h.db.$transaction(async tx => {
    await tx.$executeRawUnsafe('CREATE TABLE auth_permission_probe (id INT)');
    throw new Error('DDL unexpectedly succeeded');
  }), /permission denied|42501/i);
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const input = { email: `Chess_${suffix}@Example.test`, username: `Player_${suffix}`,
    password: '  chess café password 😀  ' };
  const canonical = { ...input, email: input.email.toLowerCase(), username: input.username.toLowerCase() };
  let response = await h.request('register', 'POST', input);
  assert.equal(response.status, 201);
  const { user } = await response.json();
  ids.push(user.id);
  assert.equal(user.email, canonical.email);
  assert.equal(user.username, canonical.username);
  assert.equal('passwordHash' in user, false);
  assert.equal(response.headers.get('set-cookie'), null);
  const stored = await h.db.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.match(stored.passwordHash, /^\$argon2id\$/);
  assert.equal(await argon2.verify(stored.passwordHash, input.password), true);
  assert.equal(await argon2.verify(stored.passwordHash, input.password.trim()), false);
  for (const duplicate of [
    { ...canonical, username: `other_${suffix}` },
    { ...canonical, email: `other_${suffix}@example.test` },
  ]) assert.equal((await h.request('register', 'POST', duplicate)).status, 409);
  const wrong = await h.request('login', 'POST', { email: canonical.email, password: 'incorrect password' });
  const missing = await h.request('login', 'POST', { email: `missing_${suffix}@example.test`, password: input.password });
  assert.equal(wrong.status, 401);
  assert.equal(missing.status, 401);
  assert.deepEqual(await wrong.json(), await missing.json());
  assert.equal(wrong.headers.get('set-cookie'), null);
  assert.equal(await h.db.session.count({ where: { userId: user.id } }), 0);
  response = await h.request('login', 'POST', { email: input.email, password: input.password });
  assert.equal(response.status, 200);
  assert.equal('passwordHash' in (await response.json()).user, false);
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) {
    assert.ok(response.headers.get('set-cookie').includes(flag));
  }
  const first = cookieOf(response);
  const session = await h.db.session.findUniqueOrThrow({ where: { tokenHash: hashOf(first) } });
  assert.equal(session.userId, user.id);
  assert.match(session.tokenHash, /^[0-9a-f]{64}$/);
  assert.equal('passwordHash' in (await h.repo.findSession(hashOf(first))).user, false);
  assert.equal((await h.request('me', 'GET', undefined, first)).status, 200);
  await h.app.close();
  h = await start();
  assert.equal((await h.request('me', 'GET', undefined, first)).status, 200, 'session survives backend restart');
  response = await h.request('login', 'POST', { email: canonical.email, password: input.password }, first);
  assert.equal(response.status, 200);
  const second = cookieOf(response);
  assert.notEqual(first, second);
  assert.equal((await h.request('me', 'GET', undefined, first)).status, 401);
  assert.equal((await h.request('me', 'GET', undefined, second)).status, 200);
  assert.equal((await h.request('logout', 'POST', {}, second)).status, 204);
  assert.equal((await h.request('logout', 'POST', {}, second)).status, 204);
  assert.equal((await h.request('me', 'GET', undefined, second)).status, 401);
  assert.equal(await h.db.session.count({ where: { userId: user.id } }), 0);
  response = await h.request('login', 'POST', { email: canonical.email, password: input.password });
  const expired = cookieOf(response);
  await h.db.session.update({ where: { tokenHash: hashOf(expired) }, data: {
    createdAt: new Date(Date.now() - 120000), expiresAt: new Date(Date.now() - 60000),
  } });
  assert.equal((await h.request('me', 'GET', undefined, expired)).status, 401);
});

test('Prisma adapter: concurrent conflicts, transaction rollback and bounded cleanup', async t => {
  const h = await start();
  const ids = [];
  t.after(async () => {
    try { await h.db.user.deleteMany({ where: { id: { in: ids } } }); }
    finally { await h.app.close(); }
  });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const input = { email: `race_${suffix}@example.test`, username: `race_${suffix}`, passwordHash: '$argon2id$fixture' };
  for (const kind of ['email', 'username']) {
    const first = { ...input, email: `${kind}_${input.email}`, username: `${kind.slice(0, 1)}_${input.username}` };
    const second = { ...first, ...(kind === 'email' ? { username: `alt_${suffix}` } : { email: `alt_${suffix}@example.test` }) };
    const results = await Promise.allSettled([h.repo.createAccount(first), h.repo.createAccount(second)]);
    for (const result of results) if (result.status === 'fulfilled') ids.push(result.value.id);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.ok(results.find(result => result.status === 'rejected').reason instanceof AccountConflictError);
  }
  const old = { userId: ids[0], tokenHash: hashSessionToken(randomUUID()),
    createdAt: new Date(), expiresAt: new Date(Date.now() + 60000) };
  await h.repo.replaceSession(null, old);
  await assert.rejects(h.repo.replaceSession(old.tokenHash, { ...old,
    tokenHash: hashSessionToken(randomUUID()), expiresAt: new Date(0) }));
  assert.ok(await h.repo.findSession(old.tokenHash), 'failed replacement restores old session');
  await assert.rejects(h.repo.replaceSession(null, old), error => !(error instanceof AccountConflictError));
  const expired = Array.from({ length: 3 }, () => ({ userId: ids[0], tokenHash: hashSessionToken(randomUUID()),
    createdAt: new Date('2000-01-01'), expiresAt: new Date('2000-01-02') }));
  await h.db.session.createMany({ data: expired });
  const deleted = await h.repo.deleteExpiredSessions(new Date('2000-01-03'), 2);
  assert.equal(deleted, 2);
  assert.equal(await h.db.session.count({ where: { tokenHash: { in: expired.map(row => row.tokenHash) } } }), 1);
  assert.ok(await h.repo.findSession(old.tokenHash));
  await h.repo.deleteSession(old.tokenHash);
  await h.repo.deleteSession(old.tokenHash);
});
