require('reflect-metadata');
require('ts-node').register({ project: 'tsconfig.tools.json' });
const { requireTestDatabaseUrl } = require('../test-database-url.ts');
process.env.DATABASE_URL = requireTestDatabaseUrl(process.env.TEST_DATABASE_URL);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { io } = require('socket.io-client');
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../../dist/app.module');
const { configureApp } = require('../../dist/configure-app');
const { PrismaService } = require('../../dist/database/prisma.service');
const { SessionService } = require('../../dist/auth/session.service');
const { AUTH_CONFIG } = require('../../dist/auth/auth.config');
const { FriendsService } = require('../../dist/friends/friends.service');
const { PresenceService } = require('../../dist/friends/presence.service');

function event(socket, name) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.off(name, done); reject(new Error(`Missing ${name}`)); }, 5000);
    function done(value) { clearTimeout(timeout); resolve(value); }
    socket.once(name, done);
  });
}
async function setup(t) {
  const app = await NestFactory.create(AppModule, { bodyParser: false, logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const db = app.get(PrismaService), sessions = app.get(SessionService);
  const base = await app.getUrl(), origin = app.get(AUTH_CONFIG).origin;
  const users = [], sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    try { await db.user.deleteMany({ where: { id: { in: users.map(user => user.id) } } }); }
    finally { await app.close(); }
  });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  for (const label of ['alice', 'bob', 'eve']) {
    const user = await db.user.create({ data: { email: `${label}_${suffix}@example.test`, username: `${label}_${suffix}`, passwordHash: '$argon2id$fixture' } });
    users.push(user);
    user.token = (await sessions.create(user.id, null)).token;
    user.cookie = `__Host-session=${user.token}`;
  }
  async function request(user, path, method = 'GET', body, extra = {}) {
    return fetch(`${base}/api/${path}`, { method, headers: {
      Origin: origin, 'X-CSRF-Protection': '1', 'Content-Type': 'application/json',
      ...(user ? { Cookie: user.cookie } : {}), ...extra,
    }, ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }) });
  }
  async function socket(user, overrides = {}) {
    const client = io(`${base}/friends`, { autoConnect: false, forceNew: true, reconnection: false,
      transports: ['websocket'], auth: { csrf: '1' }, extraHeaders: { Origin: origin, Cookie: user.cookie }, ...overrides });
    sockets.push(client);
    const ready = event(client, 'friends:ready');
    client.connect(); await ready; return client;
  }
  return { app, db, sessions, users, request, socket, base, origin, sockets,
    service: app.get(FriendsService), presence: app.get(PresenceService) };
}

test('friends API: lifecycle, private data, validation, permissions and CSRF', async t => {
  const h = await setup(t), [alice, bob, eve] = h.users;
  assert.equal((await h.request(null, 'friends')).status, 401);
  assert.equal((await h.request(alice, 'friends?limit=999')).status, 400);
  assert.equal((await h.request(alice, 'users/search?q=al')).status, 400);
  assert.equal((await h.request(alice, 'friends/requests', 'POST', { targetUserId: alice.id })).status, 400);
  assert.equal((await h.request(alice, 'friends/requests', 'POST', [])).status, 400);
  assert.equal((await h.request(alice, 'friends/requests', 'POST', JSON.parse('{"targetUserId":"' + bob.id + '","__proto__":{}}'))).status, 400);
  assert.equal((await h.request(alice, 'friends/requests', 'POST', { targetUserId: bob.id, senderId: eve.id })).status, 400);
  assert.equal((await h.request(alice, 'friends/requests', 'POST', { targetUserId: bob.id }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await h.request(alice, 'friends/requests', 'POST', { targetUserId: randomUUID() })).status, 404);
  const search = await (await h.request(alice, `users/search?q=${bob.username}`)).json();
  assert.deepEqual(Object.keys(search.items[0]).sort(), ['id', 'rating', 'username']);
  assert.equal(search.items[0].id, bob.id);
  const profile = await (await h.request(alice, `users/${bob.id}`)).json();
  assert.deepEqual(Object.keys(profile.user).sort(), ['id', 'rating', 'username']);
  let response = await h.request(alice, 'friends/requests', 'POST', { targetUserId: bob.id.toUpperCase() });
  assert.equal(response.status, 201);
  const id = (await response.json()).request.id;
  assert.equal((await h.request(bob, 'friends/requests', 'POST', { targetUserId: alice.id })).status, 409);
  assert.equal((await h.request(alice, `friends/requests/${id}/accept`, 'POST')).status, 404);
  assert.equal((await h.request(eve, `friends/requests/${id}/accept`, 'POST')).status, 404);
  assert.equal((await h.request(eve, `friends/requests/${id}`, 'DELETE')).status, 404);
  assert.equal((await (await h.request(alice, 'friends/requests?direction=outgoing')).json()).items[0].id, id);
  assert.equal((await (await h.request(bob, 'friends/requests?direction=incoming')).json()).items[0].id, id);
  assert.equal((await h.request(bob, `friends/requests/${id}/accept`, 'POST')).status, 204);
  assert.equal((await h.request(bob, `friends/requests/${id}`, 'DELETE')).status, 404, 'cancel cannot remove an accepted friendship');
  for (const [me, other] of [[alice, bob], [bob, alice]]) {
    const body = await (await h.request(me, 'friends')).json();
    assert.equal(body.items.length, 1); assert.equal(body.items[0].user.id, other.id);
    assert.equal(body.items[0].user.online, false);
    assert.equal(JSON.stringify(body).includes('password'), false);
    assert.equal(JSON.stringify(body).includes('@example'), false);
  }
  assert.equal((await h.request(alice, `friends/${bob.id}`, 'DELETE')).status, 204);
  assert.equal((await h.request(alice, `friends/${bob.id}`, 'DELETE')).status, 204);
  assert.equal((await (await h.request(bob, 'friends')).json()).items.length, 0);
  for (const actor of [alice, bob]) {
    const r = await h.service.send(alice.id, bob.id);
    assert.equal((await h.request(actor, `friends/requests/${r.request.id}`, 'DELETE')).status, 204);
  }
  // Account deletion cascades pending relationships.
  await h.service.send(alice.id, bob.id);
  await h.db.user.delete({ where: { id: bob.id } });
  assert.equal(await h.db.friendship.count({ where: { OR: [{ userLowId: alice.id }, { userHighId: alice.id }] } }), 0);
});

test('database concurrency: crossed sends, accept/cancel and pair constraints', async t => {
  const h = await setup(t), [alice, bob] = h.users;
  const results = await Promise.allSettled([h.service.send(alice.id, bob.id), h.service.send(bob.id, alice.id)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.getStatus(), 409);
  const id = results.find(r => r.status === 'fulfilled').value.request.id;
  let row = await h.db.friendship.findUniqueOrThrow({ where: { id } });
  const recipient = row.requestedById === alice.id ? bob : alice;
  const race = await Promise.allSettled([h.service.accept(recipient.id, id), h.service.removeRequest(alice.id, id)]);
  assert.equal(race.filter(r => r.status === 'fulfilled').length, 1);
  row = await h.db.friendship.findUnique({ where: { id } });
  assert.ok(row === null || row.status === 'ACCEPTED');
  await assert.rejects(h.db.friendship.create({ data: { userLowId: alice.id, userHighId: alice.id, requestedById: alice.id } }));
  const [low, high] = [alice.id, bob.id].sort();
  await assert.rejects(h.db.friendship.create({ data: { userLowId: high, userHighId: low, requestedById: low } }));
});

test('Socket.IO: multi-tab presence, friend notifications, removal and logout revocation', async t => {
  const h = await setup(t), [alice, bob, eve] = h.users;
  const r = await h.service.send(alice.id, bob.id);
  await h.service.accept(bob.id, r.request.id);
  const a = await h.socket(alice), e = await h.socket(eve);
  let outsiderEvents = 0;
  e.on('friends:changed', () => outsiderEvents++);
  const update = event(a, 'friends:changed');
  const b1 = await h.socket(bob);
  await update;
  const b2 = await h.socket(bob);
  assert.equal((await h.service.list(alice.id, {})).items[0].user.online, true);
  b1.disconnect();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(h.presence.isOnline(bob.id), true);
  const disconnected = event(b2, 'disconnect');
  assert.equal((await h.request(bob, 'auth/logout', 'POST')).status, 204);
  await disconnected;
  assert.equal(h.presence.isOnline(bob.id), false);
  assert.equal(outsiderEvents, 0);
  await h.service.removeFriend(alice.id, bob.id);
  assert.equal((await h.service.list(alice.id, {})).items.length, 0);
  await new Promise(resolve => setTimeout(resolve, 100));
  let removedFriendUpdates = 0;
  a.on('friends:changed', () => removedFriendUpdates++);
  bob.token = (await h.sessions.create(bob.id, null)).token;
  bob.cookie = `__Host-session=${bob.token}`;
  await h.socket(bob);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(removedFriendUpdates, 0, 'removed friends receive no presence updates');
  // Invalid Origin is rejected even with a valid cookie.
  const bad = io(`${h.base}/friends`, { autoConnect: false, forceNew: true, reconnection: false,
    transports: ['websocket'], auth: { csrf: '1' }, extraHeaders: { Cookie: alice.cookie, Origin: 'https://evil.example' } });
  h.sockets.push(bad);
  const rejection = event(bad, 'connect_error'); bad.connect();
  assert.equal((await rejection).message, 'FRIENDS_CONNECTION_REJECTED');
  // Directly expired sessions are removed by periodic revalidation.
  const tokenHash = require('../../dist/auth/session-cookie').hashSessionToken(alice.token);
  await h.db.session.update({ where: { tokenHash }, data: { createdAt: new Date(Date.now() - 60000), expiresAt: new Date(Date.now() - 1000) } });
  const gateway = h.app.get(require('../../dist/friends/friends.gateway').FriendsGateway);
  const expired = event(a, 'disconnect');
  await gateway.sweep(); await expired;
  assert.equal(h.presence.isOnline(alice.id), false);
});


test('friendships survive a fresh application instance and mutations are rate limited', async t => {
  const h = await setup(t), [alice, bob] = h.users;
  const r = await h.service.send(alice.id, bob.id);
  await h.service.accept(bob.id, r.request.id);
  const second = await NestFactory.create(AppModule, { bodyParser: false, logger: false, abortOnError: false });
  configureApp(second);
  await second.init();
  try {
    const stored = await second.get(FriendsService).list(alice.id, {});
    assert.equal(stored.items[0].user.id, bob.id);
  } finally { await second.close(); }
  for (let i = 0; i < 30; i++) {
    assert.equal((await h.request(alice, 'friends/requests', 'POST', { targetUserId: alice.id })).status, 400);
  }
  const limited = await h.request(alice, 'friends/requests', 'POST', { targetUserId: alice.id });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});
