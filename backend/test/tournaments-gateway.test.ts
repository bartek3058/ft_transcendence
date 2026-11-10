import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Logger, UnauthorizedException } from '@nestjs/common';
import { AuthConfig } from '../src/auth/auth.config';
import { hashSessionToken } from '../src/auth/session-cookie';
import { SessionService } from '../src/auth/session.service';
import { TournamentRateLimiter } from '../src/tournament/http/tournament-rate-limiter';
import { TournamentRealtimePayloads } from '../src/tournament/realtime/tournament-realtime.payloads';
import { REALTIME_LIMITS, TournamentsGateway } from '../src/tournament/realtime/tournaments.gateway';
import { TournamentEventsPublisher } from '../src/tournament/tournament-events.publisher';

/* Gateway logic with fakes: handshake checks, subscribe validation and limits, and the
mapping from publisher events to Socket.IO event names, rooms and payloads.
The real Socket.IO + PostgreSQL flow is covered by tournaments-realtime-postgres.test.cjs. */
Logger.overrideLogger(false);

const ORIGIN = 'https://localhost';
const TOKEN = 'a'.repeat(43);
const OTHER_TOKEN = 'b'.repeat(43);
const T1 = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';

type Emitted = { room: string; event: string; payload: any };

function harness(options: { exists?: (id: string) => boolean } = {}) {
  const revocations = new EventEmitter();
  const sessions = {
    revocations,
    authenticate: async (token: string | null) => {
      if (token === TOKEN) return { id: 'user-1' };
      if (token === OTHER_TOKEN) return { id: 'user-2' };
      throw new UnauthorizedException();
    },
  } as unknown as SessionService;
  const existsCalls: string[] = [];
  const payloads = {
    tournamentExists: async (id: string) => { existsCalls.push(id); return options.exists ? options.exists(id) : true; },
    started: async (id: string) => ({ tournamentId: id, participants: [], matches: [] }),
    matches: async (_t: string, ids: string[]) => ids.map((id) => ({ id })),
    finished: async (id: string) => ({ tournamentId: id, championId: null, finalRanks: [] }),
    invitationReceived: async (id: string) => ({ invitation: { id } }),
    invitationAnswered: async (id: string, status: string) => ({ invitation: { id, status } }),
  } as unknown as TournamentRealtimePayloads;
  const publisher = new TournamentEventsPublisher();
  const gateway = new TournamentsGateway(sessions, new TournamentRateLimiter(), payloads, publisher,
    { origin: ORIGIN } as AuthConfig);

  const emitted: Emitted[] = [];
  let middleware!: (client: any, next: (err?: Error) => void) => Promise<void>;
  const namespace = {
    use: (fn: typeof middleware) => { middleware = fn; },
    to: (room: string) => ({ emit: (event: string, payload: unknown) => { emitted.push({ room, event, payload }); } }),
  };
  gateway.afterInit(namespace as never);

  let n = 0;
  function socket(token = TOKEN) {
    const rooms = new Set<string>();
    const client = {
      id: `s${++n}`,
      data: { tournamentIdentity: { userId: token === TOKEN ? 'user-1' : 'user-2', token } } as Record<string, unknown>,
      rooms,
      emitted: [] as string[],
      disconnected: false,
      join: async (room: string) => { rooms.add(room); },
      leave: async (room: string) => { rooms.delete(room); },
      emit: (event: string) => { client.emitted.push(event); return true; },
      disconnect: () => { client.disconnected = true; },
    };
    return client;
  }
  async function handshake(headers: Record<string, string | undefined>, auth: Record<string, unknown>, address = '10.0.0.1') {
    let result: Error | undefined | 'ok';
    const client = { handshake: { headers, auth, address }, data: {} as Record<string, unknown> };
    await middleware(client, (err) => { result = err ?? 'ok'; });
    return { result, client };
  }
  return { gateway, publisher, emitted, existsCalls, revocations, socket, handshake };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
// Deferred delivery + async payload loads: wait for the expected count, not a fixed time.
async function waitFor(condition: () => boolean, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (!condition() && Date.now() < end) await tick();
}
const good = { origin: ORIGIN, cookie: `__Host-session=${TOKEN}` };

describe('TournamentsGateway: connection', () => {
  it('accepts a valid session with the right Origin and CSRF flag', async () => {
    const h = harness();
    const { result, client } = await h.handshake(good, { csrf: '1' });
    assert.equal(result, 'ok');
    assert.deepEqual(client.data.tournamentIdentity, { userId: 'user-1', token: TOKEN });
    h.gateway.onModuleDestroy();
  });

  it('rejects a wrong Origin, a missing CSRF flag, no cookie or an invalid session', async () => {
    const h = harness();
    for (const [headers, auth] of [
      [{ ...good, origin: 'https://evil.example' }, { csrf: '1' }],
      [good, {}],
      [{ origin: ORIGIN }, { csrf: '1' }],
      [{ origin: ORIGIN, cookie: `__Host-session=${'z'.repeat(43)}` }, { csrf: '1' }],
    ] as const) {
      const { result } = await h.handshake(headers as never, auth);
      assert.ok(result instanceof Error && result.message === 'TOURNAMENTS_CONNECTION_REJECTED');
    }
    h.gateway.onModuleDestroy();
  });

  it(`limits connection attempts per IP (${REALTIME_LIMITS.connectsPerIp}/min)`, async () => {
    const h = harness();
    for (let i = 0; i < REALTIME_LIMITS.connectsPerIp; i++) assert.equal((await h.handshake(good, { csrf: '1' })).result, 'ok');
    assert.ok((await h.handshake(good, { csrf: '1' })).result instanceof Error);
    assert.equal((await h.handshake(good, { csrf: '1' }, '10.0.0.2')).result, 'ok'); // other IP unaffected
    h.gateway.onModuleDestroy();
  });

  it('joins the personal room, removes the token from socket.data, caps sockets per user', async () => {
    const h = harness();
    const first = h.socket();
    h.gateway.handleConnection(first as never);
    assert.ok(first.rooms.has('user:user-1'));
    assert.equal(first.data.tournamentIdentity, undefined);
    assert.deepEqual(first.emitted, ['tournament:ready']);
    for (let i = 1; i < REALTIME_LIMITS.socketsPerUser; i++) h.gateway.handleConnection(h.socket() as never);
    const extra = h.socket();
    h.gateway.handleConnection(extra as never);
    assert.equal(extra.disconnected, true);
    h.gateway.onModuleDestroy();
  });

  it('drops the sockets of a revoked session only', async () => {
    const h = harness();
    const mine = h.socket();
    const other = h.socket(OTHER_TOKEN);
    h.gateway.handleConnection(mine as never);
    h.gateway.handleConnection(other as never);
    h.revocations.emit('revoked', hashSessionToken(TOKEN));
    assert.deepEqual([mine.disconnected, other.disconnected], [true, false]);
    assert.deepEqual(await h.gateway.subscribe(mine as never, { tournamentId: T1 }), { ok: false, error: { code: 'UNAUTHENTICATED' } });
    h.gateway.onModuleDestroy();
  });
});

describe('TournamentsGateway: subscribe', () => {
  it('rejects malformed payloads without any database access', async () => {
    const h = harness();
    const s = h.socket();
    h.gateway.handleConnection(s as never);
    for (const body of [null, 'x', [T1], {}, { tournamentId: 'R1-M1' }, { tournamentId: 42 },
      { tournamentId: T1, extra: 1 }]) {
      assert.deepEqual(await h.gateway.subscribe(s as never, body), { ok: false, error: { code: 'INVALID_ID' } });
    }
    assert.deepEqual(h.existsCalls, []);
    h.gateway.onModuleDestroy();
  });

  it('rejects an unknown tournament and joins an existing one (idempotent)', async () => {
    const h = harness({ exists: (id) => id === T1 });
    const s = h.socket();
    h.gateway.handleConnection(s as never);
    const unknown = '00000000-0000-4000-8000-000000000000';
    assert.deepEqual(await h.gateway.subscribe(s as never, { tournamentId: unknown }), { ok: false, error: { code: 'TOURNAMENT_NOT_FOUND' } });
    assert.deepEqual(await h.gateway.subscribe(s as never, { tournamentId: T1.toUpperCase() }), { ok: true });
    assert.ok(s.rooms.has(`tournament:${T1}`));
    assert.deepEqual(await h.gateway.subscribe(s as never, { tournamentId: T1 }), { ok: true });
    assert.deepEqual(await h.gateway.unsubscribeRoom(s as never, { tournamentId: T1 }), { ok: true });
    assert.ok(!s.rooms.has(`tournament:${T1}`));
    h.gateway.onModuleDestroy();
  });

  it(`caps rooms per socket (${REALTIME_LIMITS.roomsPerSocket}) and subscribes per user (${REALTIME_LIMITS.subscribesPerUser}/min)`, async () => {
    const h = harness();
    const s = h.socket();
    h.gateway.handleConnection(s as never);
    const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    for (let i = 0; i < REALTIME_LIMITS.roomsPerSocket; i++) {
      assert.deepEqual(await h.gateway.subscribe(s as never, { tournamentId: id(i) }), { ok: true });
    }
    assert.deepEqual(await h.gateway.subscribe(s as never, { tournamentId: id(99) }),
      { ok: false, error: { code: 'TOO_MANY_SUBSCRIPTIONS' } });
    const second = h.socket();
    h.gateway.handleConnection(second as never);
    let limited = false;
    for (let i = 0; i < REALTIME_LIMITS.subscribesPerUser; i++) {
      const ack = await h.gateway.subscribe(second as never, { tournamentId: id(i) });
      if ('error' in ack && ack.error.code === 'RATE_LIMITED') limited = true;
    }
    assert.ok(limited, 'the per-user limit is shared by all sockets of the user');
    h.gateway.onModuleDestroy();
  });
});

describe('TournamentsGateway: events', () => {
  const room = `tournament:${T1}`;

  it('maps participant, registration, cancel, match and finish events to the tournament room', async () => {
    const h = harness();
    const at = new Date(0);
    const participant = { tournamentId: T1, userId: 'u9', username: 'bob', currentParticipants: 3, maxParticipants: 8, at };
    h.publisher.participantJoined(participant);
    h.publisher.participantLeft({ ...participant, currentParticipants: 2 });
    h.publisher.registrationClosed({ tournamentId: T1, outcome: 'IN_PROGRESS', reason: 'MANUAL', at });
    h.publisher.registrationClosed({ tournamentId: T1, outcome: 'CANCELLED', reason: 'SCHEDULER', at });
    h.publisher.cancelled({ tournamentId: T1, at });
    h.publisher.bracketChanged(T1, ['m1', 'm2', 'm1'], true);
    await waitFor(() => h.emitted.length >= 10);
    const events = h.emitted.map((e) => [e.room, e.event]);
    assert.deepEqual(events, [
      [room, 'tournament:participant_joined'],
      [room, 'tournament:participant_left'],
      [room, 'tournament:registration_closed'],
      [room, 'tournament:started'], // snapshot loaded right after the close event
      [room, 'tournament:registration_closed'],
      [room, 'tournament:cancelled'], // close with fewer than 2 players
      [room, 'tournament:cancelled'], // manual cancel
      [room, 'tournament:match_updated'],
      [room, 'tournament:match_updated'],
      [room, 'tournament:finished'],
    ]);
    assert.deepEqual(h.emitted[0].payload, {
      tournamentId: T1, currentParticipants: 3, maxParticipants: 8, participant: { userId: 'u9', username: 'bob' },
    });
    assert.deepEqual(h.emitted[2].payload, { tournamentId: T1, status: 'IN_PROGRESS' });
    // One match_updated per changed match, duplicates removed.
    assert.deepEqual(h.emitted.filter((e) => e.event === 'tournament:match_updated').map((e) => e.payload.match.id), ['m1', 'm2']);
    h.gateway.onModuleDestroy();
  });

  it('sends invitation events to the personal rooms of the recipient and the sender', async () => {
    const h = harness();
    const base = { invitationId: 'i1', tournamentId: T1, senderId: 'alice', recipientId: 'bob', at: new Date(0) };
    h.publisher.invitationReceived(base);
    h.publisher.invitationAnswered({ ...base, status: 'DECLINED' });
    await waitFor(() => h.emitted.length >= 2);
    assert.deepEqual(h.emitted.map((e) => [e.room, e.event, e.payload.invitation]), [
      ['user:bob', 'tournament:invitation_received', { id: 'i1' }],
      ['user:alice', 'tournament:invitation_answered', { id: 'i1', status: 'DECLINED' }],
    ]);
    h.gateway.onModuleDestroy();
  });

  it('stops listening on module destroy', async () => {
    const h = harness();
    h.gateway.onModuleDestroy();
    h.publisher.cancelled({ tournamentId: T1, at: new Date(0) });
    await tick();
    assert.deepEqual(h.emitted, []);
  });
});
