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
const { TournamentsService } = require('../../dist/tournament/tournaments.service');
const { TournamentCheckInSweeper } = require('../../dist/tournament/tournament-check-in.sweeper');

// End-to-end test: real app, real HTTP, real Socket.IO client, real PostgreSQL.

function waitFor(socket, name, predicate = () => true, ms = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.off(name, handler); reject(new Error(`Missing ${name}`)); }, ms);
    function handler(value) {
      if (!predicate(value)) return;
      clearTimeout(timeout); socket.off(name, handler); resolve(value);
    }
    socket.on(name, handler);
  });
}

function none(socket, name, ms = 400) {
  return new Promise((resolve, reject) => {
    const handler = (value) => { clearTimeout(timeout); reject(new Error(`Unexpected ${name}: ${JSON.stringify(value)}`)); };
    const timeout = setTimeout(() => { socket.off(name, handler); resolve(); }, ms);
    socket.on(name, handler);
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
    const ids = users.map((u) => u.id);
    try {
      await db.game.deleteMany({ where: { OR: [{ whiteId: { in: ids } }, { blackId: { in: ids } }] } });
      await db.tournament.deleteMany({ where: { creatorId: { in: ids } } });
      await db.user.deleteMany({ where: { id: { in: ids } } });
    } finally { await app.close(); }
  });
  async function user(label) {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
    const u = await db.user.create({ data: {
      email: `${label}_${suffix}@example.test`, username: `${label}_${suffix}`, passwordHash: '$argon2id$fixture',
    } });
    u.cookie = `__Host-session=${(await sessions.create(u.id, null)).token}`;
    users.push(u);
    return u;
  }
  async function request(u, path, method = 'GET', body) {
    const response = await fetch(`${base}/api/${path}`, { method, headers: {
      Origin: origin, 'X-CSRF-Protection': '1', 'Content-Type': 'application/json',
      ...(u ? { Cookie: u.cookie } : {}),
    }, ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }
  function client(u, overrides = {}) {
    const socket = io(`${base}/tournaments`, { autoConnect: false, forceNew: true, reconnection: false,
      transports: ['websocket'], auth: { csrf: '1' },
      extraHeaders: { Origin: origin, ...(u ? { Cookie: u.cookie } : {}) }, ...overrides });
    sockets.push(socket);
    return socket;
  }
  async function connect(u) {
    const socket = client(u);
    const ready = waitFor(socket, 'tournament:ready');
    socket.connect();
    await ready;
    return socket;
  }
  async function befriend(a, b) {
    const [userLowId, userHighId] = [a.id, b.id].sort();
    await db.friendship.create({ data: { userLowId, userHighId, requestedById: a.id, status: 'ACCEPTED',
      acceptedAt: new Date(Date.now() + 1000) } });
  }
  async function createTournament(creator, maxParticipants = 4) {
    const res = await request(creator, 'tournaments', 'POST', {
      title: `rt ${randomUUID().slice(0, 8)}`, maxParticipants,
      registrationDeadline: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    assert.equal(res.status, 201);
    return res.body.id;
  }
  return { app, db, user, request, client, connect, befriend, createTournament };
}

function rejected(socket) {
  return new Promise((resolve) => {
    socket.once('connect_error', (err) => resolve(err.message));
    socket.once('tournament:ready', () => resolve('connected'));
    socket.connect();
  });
}

test('connection: session, Origin and CSRF flag are required', async (t) => {
  const h = await setup(t);
  const alice = await h.user('alice');
  assert.equal(await rejected(h.client(null)), 'TOURNAMENTS_CONNECTION_REJECTED');
  assert.equal(await rejected(h.client(alice, { extraHeaders: { Origin: 'https://evil.example', Cookie: alice.cookie } })),
    'TOURNAMENTS_CONNECTION_REJECTED');
  assert.equal(await rejected(h.client(alice, { auth: {} })), 'TOURNAMENTS_CONNECTION_REJECTED');
  assert.equal(await rejected(h.client(alice)), 'connected');
});

test('subscribe: malformed and unknown ids are refused, a real tournament is joined', async (t) => {
  const h = await setup(t);
  const alice = await h.user('alice');
  const id = await h.createTournament(alice);
  const socket = await h.connect(alice);
  assert.deepEqual(await socket.emitWithAck('tournament:subscribe', { tournamentId: 'not-a-uuid' }),
    { ok: false, error: { code: 'INVALID_ID' } });
  assert.deepEqual(await socket.emitWithAck('tournament:subscribe', { tournamentId: randomUUID() }),
    { ok: false, error: { code: 'TOURNAMENT_NOT_FOUND' } });
  assert.deepEqual(await socket.emitWithAck('tournament:subscribe', { tournamentId: id }), { ok: true });
});

test('registration, invitations, start and check-in events reach the right rooms', async (t) => {
  const h = await setup(t);
  const [alice, bob, carol] = [await h.user('alice'), await h.user('bob'), await h.user('carol')];
  await h.befriend(alice, bob);
  const id = await h.createTournament(alice);
  const [aliceS, bobS, carolS] = [await h.connect(alice), await h.connect(bob), await h.connect(carol)];
  for (const s of [aliceS, carolS]) assert.deepEqual(await s.emitWithAck('tournament:subscribe', { tournamentId: id }), { ok: true });

  // Invitation: recipient's personal room, then the sender's.
  let received = waitFor(bobS, 'tournament:invitation_received');
  const invite = await h.request(alice, `tournaments/${id}/invitations`, 'POST', { recipientId: bob.id });
  assert.equal(invite.status, 201);
  const inv = (await received).invitation;
  assert.deepEqual([inv.id, inv.tournamentId, inv.sender.userId], [invite.body.invitationId, id, alice.id]);
  const answered = waitFor(aliceS, 'tournament:invitation_answered');
  let joined = waitFor(carolS, 'tournament:participant_joined');
  assert.equal((await h.request(bob, `tournaments/invitations/${inv.id}/respond`, 'POST', { response: 'ACCEPT' })).status, 200);
  assert.deepEqual((await answered).invitation.status, 'ACCEPTED');
  assert.deepEqual(await joined, {
    tournamentId: id, currentParticipants: 1, maxParticipants: 4, participant: { userId: bob.id, username: bob.username },
  });

  // Join/leave; a rolled-back join announces nothing.
  joined = waitFor(aliceS, 'tournament:participant_joined', (e) => e.participant.userId === carol.id);
  assert.equal((await h.request(carol, `tournaments/${id}/join`, 'POST')).status, 200);
  assert.equal((await joined).currentParticipants, 2);
  const silent = none(aliceS, 'tournament:participant_joined');
  assert.equal((await h.request(carol, `tournaments/${id}/join`, 'POST')).status, 409);
  await silent;
  const left = waitFor(aliceS, 'tournament:participant_left');
  assert.equal((await h.request(carol, `tournaments/${id}/leave`, 'POST')).status, 200);
  assert.equal((await left).currentParticipants, 1);
  assert.equal((await h.request(carol, `tournaments/${id}/join`, 'POST')).status, 200);

  // Close: registration_closed, then the bracket snapshot.
  const closed = waitFor(carolS, 'tournament:registration_closed');
  const started = waitFor(carolS, 'tournament:started');
  assert.equal((await h.request(alice, `tournaments/${id}/close-registration`, 'POST')).status, 200);
  assert.deepEqual(await closed, { tournamentId: id, status: 'IN_PROGRESS' });
  const snapshot = await started;
  assert.equal(snapshot.participants.length, 2);
  assert.equal(snapshot.matches.length, 1);
  assert.ok(!JSON.stringify(snapshot).includes('"rating"'));
  const match = snapshot.matches[0];

  const path = `tournaments/${id}/matches/${match.id}/check-in`;
  assert.equal((await h.request(bob, `tournaments/${id}/matches/R1-M1/check-in`, 'POST')).status, 400);
  assert.equal((await h.request(null, path, 'POST')).status, 401);
  const forbidden = await h.request(alice, path, 'POST');
  assert.deepEqual([forbidden.status, forbidden.body.error.code], [403, 'NOT_MATCH_PLAYER']);

  let updated = waitFor(carolS, 'tournament:match_updated', (e) => e.match.player1CheckedIn || e.match.player2CheckedIn);
  assert.equal((await h.request(bob, path, 'POST')).status, 200);
  assert.equal((await updated).match.status, 'SCHEDULED');
  updated = waitFor(carolS, 'tournament:match_updated', (e) => e.match.status === 'IN_PROGRESS');
  const second = await h.request(carol, path, 'POST');
  assert.equal(second.status, 200);
  assert.equal((await updated).match.currentGameId, second.body.gameId);
});

test('a double-forfeit cascade emits one match_updated per changed match, then finished', async (t) => {
  const h = await setup(t);
  const players = [await h.user('p1'), await h.user('p2'), await h.user('p3'), await h.user('p4')];
  const watcher = await h.user('watch');
  const id = await h.createTournament(players[0]);
  const tournaments = h.app.get(TournamentsService);
  for (const p of players) await tournaments.join(p.id, id);
  const socket = await h.connect(watcher);
  assert.deepEqual(await socket.emitWithAck('tournament:subscribe', { tournamentId: id }), { ok: true });
  const started = waitFor(socket, 'tournament:started');
  assert.equal((await h.request(players[0], `tournaments/${id}/close-registration`, 'POST')).status, 200);
  const round1 = (await started).matches.filter((m) => m.round === 1);
  const final = (await started).matches.find((m) => m.round === 2);

  await h.db.tournamentMatch.updateMany({ where: { id: { in: round1.map((m) => m.id) } },
    data: { checkInDeadline: new Date(Date.now() - 60_000) } });
  const player = players.find((p) => p.id === round1[0].player1.id);
  const late = await h.request(player, `tournaments/${id}/matches/${round1[0].id}/check-in`, 'POST');
  assert.deepEqual([late.status, late.body.error.code], [409, 'CHECK_IN_CLOSED']);

  const seen = [];
  socket.on('tournament:match_updated', (e) => seen.push(e.match.id));
  const finished = waitFor(socket, 'tournament:finished');
  const sweeper = h.app.get(TournamentCheckInSweeper);
  for (const m of round1) await sweeper.resolve(id, m.id); // the app's own sweep may win: same events
  const done = await finished;
  assert.deepEqual([done.tournamentId, done.championId], [id, null]);
  // Nobody reached the Final: all four lost in Round 1 and share rank 3.
  assert.deepEqual(done.finalRanks.map((r) => r.finalRank), [3, 3, 3, 3]);
  // match_updated and finished load their payloads independently: wait for all three.
  const expected = new Set([...round1.map((m) => m.id), final.id]);
  for (let i = 0; i < 50 && new Set(seen).size < expected.size; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(new Set(seen), expected);
});
