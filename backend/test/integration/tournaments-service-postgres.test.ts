import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../src/database/prisma.service';
import { TournamentHttpError } from '../../src/tournament/http/tournament.errors';
import { TournamentBracketService } from '../../src/tournament/tournament-bracket.service';
import { MAX_START_ATTEMPTS, TournamentDeadlineScheduler } from '../../src/tournament/tournament-deadline.scheduler';
import { RegistrationClosedEvent, TournamentEventsPublisher } from '../../src/tournament/tournament-events.publisher';
import { TournamentLifecycleService } from '../../src/tournament/tournament-lifecycle.service';
import { TournamentsService } from '../../src/tournament/tournaments.service';
import { requireTestDatabaseUrl } from '../test-database-url';

// Real PostgreSQL test for the #102 routes' service layer: the conditional raw-SQL
// counter updates, unique-index rollback and close-once behaviour under concurrency.
const prisma = new PrismaService({
  datasources: { db: { url: requireTestDatabaseUrl(process.env.TEST_DATABASE_URL) } },
});
const publisher = new TournamentEventsPublisher();
const lifecycle = new TournamentLifecycleService(prisma, new TournamentBracketService(prisma), publisher);
const service = new TournamentsService(prisma, lifecycle, publisher);

/** Collects registration-closed events for one tournament; each entry has the status seen by the listener. */
function recordEvents(tournamentId: string) {
  const seen: (RegistrationClosedEvent & { dbStatus: string })[] = [];
  const unsubscribe = publisher.onRegistrationClosed(async (event) => {
    if (event.tournamentId !== tournamentId) return;
    const row = await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } });
    seen.push({ ...event, dbStatus: row.status });
  });
  return { seen, unsubscribe };
}

/** Lets deferred listeners (setImmediate + their DB read) finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

const userIds: string[] = [];
const tournamentIds: string[] = [];
const MINUTE = 60_000;

async function createUser(role = 'user', rating = 1200) {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const user = await prisma.user.create({ data: {
    email: `t102_${suffix}@example.test`, username: `t102_${suffix}`, role, rating,
    passwordHash: '$argon2id$test-fixture-not-a-real-password',
  } });
  userIds.push(user.id);
  return user;
}

const inMinutes = (minutes: number) => new Date(Date.now() + minutes * MINUTE).toISOString();

async function createTournament(creatorId: string, maxParticipants = 8, deadlineMinutes = 10) {
  const t = await service.create(creatorId, {
    title: `t102 ${randomUUID().slice(0, 8)}`, maxParticipants,
    registrationDeadline: inMinutes(deadlineMinutes),
  });
  tournamentIds.push(t.id);
  return t;
}

async function expectError(promise: Promise<unknown>, status: number, code: string) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof TournamentHttpError, `expected TournamentHttpError, got ${String(err)}`);
    assert.equal(err.getStatus(), status);
    assert.equal((err.getResponse() as { error: { code: string } }).error.code, code);
    return true;
  });
}

function codeOf(result: PromiseSettledResult<unknown>): string | undefined {
  if (result.status === 'fulfilled') return undefined;
  const reason = result.reason as TournamentHttpError;
  return (reason.getResponse() as { error: { code: string } }).error.code;
}

async function counterAndRows(id: string) {
  const t = await prisma.tournament.findUniqueOrThrow({ where: { id } });
  const rows = await prisma.tournamentParticipant.count({ where: { tournamentId: id } });
  return { counter: t.currentParticipants, rows, status: t.status };
}

describe('Tournaments service against PostgreSQL (#102)', () => {
  before(async () => { await prisma.$connect(); });

  after(async () => {
    try {
      // Fixtures only (dedicated *_test database): tournaments cascade to participants/matches.
      await prisma.tournament.deleteMany({ where: { id: { in: tournamentIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } finally {
      await prisma.$disconnect();
    }
  });

  describe('create', () => {
    it('creates an OPEN_FOR_SIGNUP tournament owned by the caller, without auto-join', async () => {
      const creator = await createUser();
      const t = await service.create(creator.id, {
        title: 'Autumn Cup', description: '', maxParticipants: 4, registrationDeadline: inMinutes(10),
      });
      tournamentIds.push(t.id);
      assert.equal(t.status, 'OPEN_FOR_SIGNUP');
      assert.equal(t.creator.id, creator.id);
      assert.equal(t.description, null);
      assert.equal(t.currentParticipants, 0);
      assert.ok(!('rating' in t.creator));
    });

    it('rejects deadlines outside 5 minutes .. 30 days with 400', async () => {
      const creator = await createUser();
      const base = { title: 'Cup', maxParticipants: 4 };
      await expectError(service.create(creator.id, { ...base, registrationDeadline: inMinutes(4) }), 400, 'DEADLINE_TOO_SOON');
      await expectError(service.create(creator.id, { ...base, registrationDeadline: inMinutes(-1) }), 400, 'DEADLINE_TOO_SOON');
      await expectError(service.create(creator.id, { ...base, registrationDeadline: inMinutes(30 * 24 * 60 + 1) }), 400, 'DEADLINE_TOO_FAR');
    });
  });

  describe('list', () => {
    it('sorts the open tab by deadline ascending and pages consistently', async () => {
      const creator = await createUser();
      const later = await createTournament(creator.id, 4, 9);
      const soon = await createTournament(creator.id, 4, 6);
      const mid = await createTournament(creator.id, 4, 7);
      const page = await service.list({ status: 'open', limit: '50' });
      const ours = page.items.map((t) => t.id).filter((id) => [later.id, soon.id, mid.id].includes(id));
      assert.deepEqual(ours, [soon.id, mid.id, later.id]);
      assert.ok(page.items.every((t) => t.status === 'OPEN_FOR_SIGNUP'));
      for (let i = 1; i < page.items.length; i++) {
        assert.ok(page.items[i - 1].registrationDeadline <= page.items[i].registrationDeadline);
      }
      assert.equal(page.limit, 50);
      assert.equal(page.offset, 0);
      assert.ok(page.total >= 3);

      const second = await service.list({ status: 'open', limit: '1', offset: '1' });
      assert.equal(second.items.length, 1);
      assert.equal(second.items[0].id, page.items[1].id);
    });

    it('defaults to the open tab and routes statuses to their tabs', async () => {
      const creator = await createUser();
      const t = await createTournament(creator.id);
      await prisma.tournament.update({ where: { id: t.id }, data: { status: 'CANCELLED' } });
      const open = await service.list({});
      assert.ok(!open.items.some((i) => i.id === t.id));
      const past = await service.list({ status: 'past', limit: '50' });
      assert.ok(past.items.every((i) => i.status === 'FINISHED' || i.status === 'CANCELLED'));
      assert.ok(past.items.some((i) => i.id === t.id));
    });
  });

  describe('join', () => {
    it('never overbooks the last slot under concurrent joins', async () => {
      const creator = await createUser();
      const t = await createTournament(creator.id, 2);
      const players = await Promise.all([1, 2, 3, 4, 5].map(() => createUser()));
      const results = await Promise.allSettled(players.map((p) => service.join(p.id, t.id)));
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
      assert.deepEqual(results.filter((r) => r.status === 'rejected').map(codeOf), ['TOURNAMENT_FULL', 'TOURNAMENT_FULL', 'TOURNAMENT_FULL']);
      const state = await counterAndRows(t.id);
      assert.equal(state.counter, 2);
      assert.equal(state.rows, 2);
    });

    it('returns 409 ALREADY_JOINED for a double join, sequential or concurrent, and keeps the counter', async () => {
      const creator = await createUser();
      const t = await createTournament(creator.id, 8);
      const player = await createUser();
      assert.deepEqual(await service.join(player.id, t.id), { currentParticipants: 1 });
      await expectError(service.join(player.id, t.id), 409, 'ALREADY_JOINED');

      // Concurrent: the second UPDATE succeeds, the INSERT hits P2002 and the increment rolls back.
      const racer = await createUser();
      const race = await Promise.allSettled([service.join(racer.id, t.id), service.join(racer.id, t.id)]);
      assert.deepEqual(race.map(codeOf).sort(), [undefined, 'ALREADY_JOINED'].sort());
      const state = await counterAndRows(t.id);
      assert.equal(state.counter, 2);
      assert.equal(state.rows, 2);
    });

    it('reports ALREADY_JOINED rather than TOURNAMENT_FULL for a member of a full tournament', async () => {
      const creator = await createUser();
      const t = await createTournament(creator.id, 2);
      const [a, b] = [await createUser(), await createUser()];
      await service.join(a.id, t.id);
      await service.join(b.id, t.id);
      await expectError(service.join(a.id, t.id), 409, 'ALREADY_JOINED');
    });

    it('returns 404 for an unknown tournament and 409 REGISTRATION_CLOSED after the deadline', async () => {
      const player = await createUser();
      await expectError(service.join(player.id, randomUUID()), 404, 'TOURNAMENT_NOT_FOUND');
      const t = await createTournament(player.id);
      await prisma.tournament.update({ where: { id: t.id }, data: { registrationDeadline: new Date(Date.now() - MINUTE) } });
      await expectError(service.join(player.id, t.id), 409, 'REGISTRATION_CLOSED');
      assert.equal((await counterAndRows(t.id)).counter, 0);
    });
  });

  describe('leave', () => {
    it('decrements the counter and removes the row; a second leave is NOT_JOINED', async () => {
      const creator = await createUser();
      const t = await createTournament(creator.id);
      const [a, b] = [await createUser(), await createUser()];
      await service.join(a.id, t.id);
      await service.join(b.id, t.id);
      assert.deepEqual(await service.leave(a.id, t.id), { currentParticipants: 1 });
      await expectError(service.leave(a.id, t.id), 409, 'NOT_JOINED');
      const state = await counterAndRows(t.id);
      assert.equal(state.counter, 1);
      assert.equal(state.rows, 1);
    });

    it('returns 404 for an unknown id and REGISTRATION_CLOSED after the deadline or once closed', async () => {
      const player = await createUser();
      await expectError(service.leave(player.id, randomUUID()), 404, 'TOURNAMENT_NOT_FOUND');
      const t = await createTournament(player.id);
      await service.join(player.id, t.id);
      await prisma.tournament.update({ where: { id: t.id }, data: { registrationDeadline: new Date(Date.now() - MINUTE) } });
      await expectError(service.leave(player.id, t.id), 409, 'REGISTRATION_CLOSED');
      await prisma.tournament.update({ where: { id: t.id }, data: { registrationDeadline: new Date(Date.now() + 10 * MINUTE), status: 'CANCELLED' } });
      await expectError(service.leave(player.id, t.id), 409, 'REGISTRATION_CLOSED');
      assert.equal((await counterAndRows(t.id)).rows, 1);
    });
  });

  describe('close-registration', () => {
    it('allows only the creator or an admin; 404 for an unknown id', async () => {
      const creator = await createUser();
      const stranger = await createUser();
      const admin = await createUser('admin');
      const t = await createTournament(creator.id);
      await expectError(service.closeRegistration(stranger.id, t.id), 403, 'FORBIDDEN');
      await expectError(service.closeRegistration(creator.id, randomUUID()), 404, 'TOURNAMENT_NOT_FOUND');
      assert.equal((await counterAndRows(t.id)).status, 'OPEN_FOR_SIGNUP');
      // Admin, 0 participants -> CANCELLED.
      assert.deepEqual(await service.closeRegistration(admin.id, t.id), { status: 'CANCELLED' });
    });

    it('cancels a tournament with fewer than 2 participants', async () => {
      const creator = await createUser();
      const t = await createTournament(creator.id);
      await service.join(creator.id, t.id);
      assert.deepEqual(await service.closeRegistration(creator.id, t.id), { status: 'CANCELLED' });
      assert.equal(await prisma.tournamentMatch.count({ where: { tournamentId: t.id } }), 0);
    });

    it('starts the bracket exactly once under concurrent closes', async () => {
      const creator = await createUser();
      const t = await createTournament(creator.id, 4);
      for (const p of [await createUser(), await createUser(), await createUser()]) await service.join(p.id, t.id);
      const results = await Promise.allSettled([
        service.closeRegistration(creator.id, t.id),
        service.closeRegistration(creator.id, t.id),
        lifecycle.closeAndStart(t.id, 'MANUAL'),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      assert.deepEqual(results.filter((r) => r.status === 'rejected').map(codeOf), ['REGISTRATION_CLOSED', 'REGISTRATION_CLOSED']);
      assert.equal((await counterAndRows(t.id)).status, 'IN_PROGRESS');
      assert.equal(await prisma.tournamentMatch.count({ where: { tournamentId: t.id } }), 3); // 4-bracket
      await expectError(service.closeRegistration(creator.id, t.id), 409, 'REGISTRATION_CLOSED');
    });

    it('the scheduler source does not close before the deadline', async () => {
      const creator = await createUser();
      const t = await createTournament(creator.id);
      await expectError(lifecycle.closeAndStart(t.id, 'SCHEDULER'), 409, 'REGISTRATION_CLOSED');
      assert.equal((await counterAndRows(t.id)).status, 'OPEN_FOR_SIGNUP');
    });

    it('keeps counter and rows consistent when joins race a close', async () => {
      const creator = await createUser();
      const t = await createTournament(creator.id, 8);
      await service.join(creator.id, t.id);
      const players = await Promise.all([1, 2, 3, 4].map(() => createUser()));
      await Promise.allSettled([
        ...players.map((p) => service.join(p.id, t.id)),
        service.closeRegistration(creator.id, t.id),
      ]);
      const state = await counterAndRows(t.id);
      assert.equal(state.counter, state.rows);
      assert.ok(state.status === 'IN_PROGRESS' || state.status === 'CANCELLED');
      await expectError(service.join((await createUser()).id, t.id), 409, 'REGISTRATION_CLOSED');
    });
  });

  describe('registration-closed events', () => {
    it('publishes one event after commit, for both outcomes', async () => {
      const creator = await createUser();
      const started = await createTournament(creator.id, 2);
      for (const p of [await createUser(), await createUser()]) await service.join(p.id, started.id);
      const cancelled = await createTournament(creator.id);
      const a = recordEvents(started.id);
      const b = recordEvents(cancelled.id);
      try {
        await lifecycle.closeAndStart(started.id, 'MANUAL');
        await lifecycle.closeAndStart(cancelled.id, 'MANUAL');
        await settle();
        // dbStatus: the listener already sees the committed state.
        assert.deepEqual(a.seen.map((e) => [e.outcome, e.reason, e.dbStatus]), [['IN_PROGRESS', 'MANUAL', 'IN_PROGRESS']]);
        assert.deepEqual(b.seen.map((e) => [e.outcome, e.reason, e.dbStatus]), [['CANCELLED', 'MANUAL', 'CANCELLED']]);
      } finally {
        a.unsubscribe();
        b.unsubscribe();
      }
    });

    it('publishes exactly once under concurrent closes', async () => {
      const creator = await createUser();
      const t = await createTournament(creator.id, 4);
      for (const p of [await createUser(), await createUser()]) await service.join(p.id, t.id);
      const rec = recordEvents(t.id);
      try {
        await Promise.allSettled([1, 2, 3].map(() => lifecycle.closeAndStart(t.id, 'MANUAL')));
        await settle();
        assert.equal(rec.seen.length, 1);
      } finally {
        rec.unsubscribe();
      }
    });

    it('publishes nothing for a rejected close (404, 409, scheduler before the deadline)', async () => {
      const creator = await createUser();
      const t = await createTournament(creator.id);
      const unknown = randomUUID();
      const recT = recordEvents(t.id);
      const recUnknown = recordEvents(unknown);
      try {
        await expectError(lifecycle.closeAndStart(unknown, 'MANUAL'), 404, 'TOURNAMENT_NOT_FOUND');
        await expectError(lifecycle.closeAndStart(t.id, 'SCHEDULER'), 409, 'REGISTRATION_CLOSED');
        await prisma.tournament.update({ where: { id: t.id }, data: { status: 'CANCELLED' } });
        await expectError(lifecycle.closeAndStart(t.id, 'MANUAL'), 409, 'REGISTRATION_CLOSED');
        await settle();
        assert.equal(recT.seen.length + recUnknown.seen.length, 0);
      } finally {
        recT.unsubscribe();
        recUnknown.unsubscribe();
      }
    });

    it('rolls back the close and publishes nothing when bracket generation fails', async () => {
      class FailingBracket extends TournamentBracketService {
        override async generateAndSaveBracket(): Promise<never> { throw new Error('bracket failure'); }
      }
      const failing = new TournamentLifecycleService(prisma, new FailingBracket(prisma), publisher);
      const creator = await createUser();
      const t = await createTournament(creator.id, 4);
      for (const p of [await createUser(), await createUser()]) await service.join(p.id, t.id);
      const rec = recordEvents(t.id);
      try {
        await assert.rejects(failing.closeAndStart(t.id, 'MANUAL'), /bracket failure/);
        await settle();
        assert.equal(rec.seen.length, 0);
        const state = await counterAndRows(t.id);
        assert.equal(state.status, 'OPEN_FOR_SIGNUP');
        assert.equal(state.counter, 2);
      } finally {
        rec.unsubscribe();
      }
    });

    it('the scheduler closes an expired registration and reports its reason', async () => {
      const creator = await createUser();
      const t = await createTournament(creator.id, 2);
      for (const p of [await createUser(), await createUser()]) await service.join(p.id, t.id);
      await prisma.tournament.update({ where: { id: t.id }, data: { registrationDeadline: new Date(Date.now() - MINUTE) } });
      const rec = recordEvents(t.id);
      try {
        assert.equal(await lifecycle.closeAndStart(t.id, 'SCHEDULER'), 'IN_PROGRESS');
        await settle();
        assert.deepEqual(rec.seen.map((e) => [e.outcome, e.reason]), [['IN_PROGRESS', 'SCHEDULER']]);
      } finally {
        rec.unsubscribe();
      }
    });
  });

  describe('deadline scheduler', () => {
    // Ticks also touch other expired fixtures in this *_test database, so assertions are per tournament.
    const expire = (id: string) => prisma.tournament.update({
      where: { id }, data: { registrationDeadline: new Date(Date.now() - MINUTE) },
    });

    it('starts expired tournaments with 2+ players, cancels the rest, and leaves future ones open', async () => {
      const creator = await createUser();
      const full = await createTournament(creator.id, 2);
      const partial = await createTournament(creator.id, 8);
      const lonely = await createTournament(creator.id, 8);
      const future = await createTournament(creator.id, 8);
      for (const p of [await createUser(), await createUser()]) await service.join(p.id, full.id);
      for (const p of [await createUser(), await createUser(), await createUser()]) await service.join(p.id, partial.id);
      await service.join(creator.id, lonely.id);
      await service.join(creator.id, future.id);
      await Promise.all([full.id, partial.id, lonely.id].map(expire));

      await new TournamentDeadlineScheduler(prisma, lifecycle).tick();

      assert.equal((await counterAndRows(full.id)).status, 'IN_PROGRESS');
      assert.equal((await counterAndRows(partial.id)).status, 'IN_PROGRESS');
      assert.equal(await prisma.tournamentMatch.count({ where: { tournamentId: partial.id } }), 3); // 3 players -> 4-bracket
      assert.equal((await counterAndRows(lonely.id)).status, 'CANCELLED');
      assert.equal((await counterAndRows(future.id)).status, 'OPEN_FOR_SIGNUP');
    });

    it('a full tournament waits for its deadline, then the scheduler starts it', async () => {
      const creator = await createUser();
      const t = await createTournament(creator.id, 2);
      for (const p of [await createUser(), await createUser()]) await service.join(p.id, t.id);
      const scheduler = new TournamentDeadlineScheduler(prisma, lifecycle);
      await scheduler.tick();
      assert.equal((await counterAndRows(t.id)).status, 'OPEN_FOR_SIGNUP');
      await expire(t.id);
      await scheduler.tick();
      assert.equal((await counterAndRows(t.id)).status, 'IN_PROGRESS');
    });

    it('two schedulers and a manual close racing produce one bracket and one event', async () => {
      const creator = await createUser();
      const t = await createTournament(creator.id, 4);
      for (const p of [await createUser(), await createUser(), await createUser(), await createUser()]) {
        await service.join(p.id, t.id);
      }
      await expire(t.id);
      const rec = recordEvents(t.id);
      try {
        await Promise.allSettled([
          new TournamentDeadlineScheduler(prisma, lifecycle).tick(),
          new TournamentDeadlineScheduler(prisma, lifecycle).tick(),
          service.closeRegistration(creator.id, t.id),
        ]);
        await settle();
        assert.equal((await counterAndRows(t.id)).status, 'IN_PROGRESS');
        assert.equal(await prisma.tournamentMatch.count({ where: { tournamentId: t.id } }), 3);
        assert.equal(rec.seen.length, 1);
      } finally {
        rec.unsubscribe();
      }
    });

    it('retries a tournament stuck in REGISTRATION_CLOSED', async () => {
      const creator = await createUser();
      const stuck = await createTournament(creator.id, 4);
      const stuckEmpty = await createTournament(creator.id, 4);
      for (const p of [await createUser(), await createUser()]) await service.join(p.id, stuck.id);
      await service.join(creator.id, stuckEmpty.id);
      // Simulates a close whose bracket start never happened (e.g. legacy data or a manual DB fix).
      await prisma.tournament.updateMany({
        where: { id: { in: [stuck.id, stuckEmpty.id] } }, data: { status: 'REGISTRATION_CLOSED' },
      });
      const rec = recordEvents(stuck.id);
      try {
        await new TournamentDeadlineScheduler(prisma, lifecycle).tick();
        await settle();
        assert.equal((await counterAndRows(stuck.id)).status, 'IN_PROGRESS');
        assert.equal(await prisma.tournamentMatch.count({ where: { tournamentId: stuck.id } }), 1);
        assert.equal((await counterAndRows(stuckEmpty.id)).status, 'CANCELLED');
        assert.deepEqual(rec.seen.map((e) => [e.outcome, e.reason]), [['IN_PROGRESS', 'SCHEDULER']]);
      } finally {
        rec.unsubscribe();
      }
    });

    it(`cancels a tournament after ${MAX_START_ATTEMPTS} failed bracket starts, never a started one`, async () => {
      class FailingBracket extends TournamentBracketService {
        override async generateAndSaveBracket(): Promise<never> { throw new Error('bracket failure'); }
      }
      const failing = new TournamentLifecycleService(prisma, new FailingBracket(prisma), publisher);
      const scheduler = new TournamentDeadlineScheduler(prisma, failing);
      const creator = await createUser();
      const t = await createTournament(creator.id, 4);
      for (const p of [await createUser(), await createUser()]) await service.join(p.id, t.id);
      await expire(t.id);
      const rec = recordEvents(t.id);
      try {
        for (let i = 1; i < MAX_START_ATTEMPTS; i++) {
          await scheduler.tick();
          assert.equal((await counterAndRows(t.id)).status, 'OPEN_FOR_SIGNUP'); // each failure rolled back
        }
        await scheduler.tick();
        await settle();
        assert.equal((await counterAndRows(t.id)).status, 'CANCELLED');
        assert.equal(await prisma.tournamentMatch.count({ where: { tournamentId: t.id } }), 0);
        assert.deepEqual(rec.seen.map((e) => [e.outcome, e.reason]), [['CANCELLED', 'SCHEDULER']]);
      } finally {
        rec.unsubscribe();
      }

      // The give-up cancel never touches a tournament that is running or still before its deadline.
      const running = await createTournament(creator.id, 2);
      const open = await createTournament(creator.id, 2);
      await prisma.tournament.update({ where: { id: running.id }, data: { status: 'IN_PROGRESS' } });
      assert.equal(await failing.cancelUnstartable(running.id), false);
      assert.equal(await failing.cancelUnstartable(open.id), false);
      assert.equal((await counterAndRows(running.id)).status, 'IN_PROGRESS');
      assert.equal((await counterAndRows(open.id)).status, 'OPEN_FOR_SIGNUP');
    });

    it('a concurrent retry of the same stuck tournament starts it once', async () => {
      const creator = await createUser();
      const t = await createTournament(creator.id, 2);
      for (const p of [await createUser(), await createUser()]) await service.join(p.id, t.id);
      await prisma.tournament.update({ where: { id: t.id }, data: { status: 'REGISTRATION_CLOSED' } });
      const results = await Promise.allSettled([lifecycle.startClosed(t.id), lifecycle.startClosed(t.id)]);
      assert.deepEqual(results.map(codeOf).sort(), [undefined, 'REGISTRATION_CLOSED'].sort());
      assert.equal(await prisma.tournamentMatch.count({ where: { tournamentId: t.id } }), 1);
    });
  });

  describe('cancel', () => {
    function recordCancels(tournamentId: string) {
      const seen: string[] = [];
      const unsubscribe = publisher.onCancelled((e) => { if (e.tournamentId === tournamentId) seen.push(e.tournamentId); });
      return { seen, unsubscribe };
    }

    it('cancels an open tournament for the creator, keeping participant rows; one event', async () => {
      const creator = await createUser();
      const t = await createTournament(creator.id);
      for (const p of [await createUser(), await createUser()]) await service.join(p.id, t.id);
      const rec = recordCancels(t.id);
      try {
        assert.deepEqual(await service.cancel(creator.id, t.id), { status: 'CANCELLED' });
        await settle();
        const state = await counterAndRows(t.id);
        assert.equal(state.status, 'CANCELLED');
        assert.equal(state.counter, 2);
        assert.equal(state.rows, 2);
        assert.equal(rec.seen.length, 1);
      } finally {
        rec.unsubscribe();
      }
      await expectError(service.join((await createUser()).id, t.id), 409, 'REGISTRATION_CLOSED');
    });

    it('allows only the creator or an admin; 404 for an unknown id', async () => {
      const creator = await createUser();
      const stranger = await createUser();
      const admin = await createUser('admin');
      const t = await createTournament(creator.id);
      await expectError(service.cancel(stranger.id, t.id), 403, 'FORBIDDEN');
      await expectError(service.cancel(admin.id, randomUUID()), 404, 'TOURNAMENT_NOT_FOUND');
      assert.equal((await counterAndRows(t.id)).status, 'OPEN_FOR_SIGNUP');
      assert.deepEqual(await service.cancel(admin.id, t.id), { status: 'CANCELLED' });
    });

    it('cancels from REGISTRATION_CLOSED; 409 for IN_PROGRESS, FINISHED and CANCELLED', async () => {
      const creator = await createUser();
      const statuses = ['REGISTRATION_CLOSED', 'IN_PROGRESS', 'FINISHED', 'CANCELLED'] as const;
      const ids: Record<string, string> = {};
      for (const status of statuses) {
        const t = await createTournament(creator.id);
        await prisma.tournament.update({ where: { id: t.id }, data: { status } });
        ids[status] = t.id;
      }
      assert.deepEqual(await service.cancel(creator.id, ids.REGISTRATION_CLOSED), { status: 'CANCELLED' });
      for (const status of ['IN_PROGRESS', 'FINISHED', 'CANCELLED']) {
        await expectError(service.cancel(creator.id, ids[status]), 409, 'TOURNAMENT_NOT_CANCELLABLE');
        assert.equal((await counterAndRows(ids[status])).status, status);
      }
    });

    it('a cancel racing joins leaves counter and rows consistent', async () => {
      const creator = await createUser();
      const t = await createTournament(creator.id, 8);
      const players = await Promise.all([1, 2, 3, 4, 5].map(() => createUser()));
      const results = await Promise.allSettled([
        ...players.map((p) => service.join(p.id, t.id)),
        service.cancel(creator.id, t.id),
      ]);
      assert.equal(results[results.length - 1].status, 'fulfilled');
      for (const r of results.slice(0, -1)) assert.ok(r.status === 'fulfilled' || codeOf(r) === 'REGISTRATION_CLOSED');
      const state = await counterAndRows(t.id);
      assert.equal(state.status, 'CANCELLED');
      assert.equal(state.counter, state.rows);
      assert.equal(state.rows, results.slice(0, -1).filter((r) => r.status === 'fulfilled').length);
    });

    it('a cancel racing a close and the scheduler ends in exactly one outcome', async () => {
      for (let round = 0; round < 5; round++) {
        const creator = await createUser();
        const t = await createTournament(creator.id, 4);
        for (const p of [await createUser(), await createUser(), await createUser()]) await service.join(p.id, t.id);
        await prisma.tournament.update({ where: { id: t.id }, data: { registrationDeadline: new Date(Date.now() - MINUTE) } });
        const closes = recordEvents(t.id);
        const cancels = recordCancels(t.id);
        try {
          const [cancel, close] = await Promise.allSettled([
            service.cancel(creator.id, t.id),
            service.closeRegistration(creator.id, t.id),
            new TournamentDeadlineScheduler(prisma, lifecycle).tick(),
          ]);
          await settle();
          const state = await counterAndRows(t.id);
          const matches = await prisma.tournamentMatch.count({ where: { tournamentId: t.id } });
          if (state.status === 'CANCELLED') {
            assert.equal(cancel.status, 'fulfilled');
            assert.equal(codeOf(close), 'REGISTRATION_CLOSED');
            assert.equal(matches, 0);
            assert.deepEqual([cancels.seen.length, closes.seen.length], [1, 0]);
          } else {
            assert.equal(state.status, 'IN_PROGRESS');
            assert.equal(codeOf(cancel), 'TOURNAMENT_NOT_CANCELLABLE');
            assert.equal(matches, 3);
            assert.deepEqual([cancels.seen.length, closes.seen.length], [0, 1]);
          }
        } finally {
          closes.unsubscribe();
          cancels.unsubscribe();
        }
      }
    });
  });

  describe('detail', () => {
    it('returns frozen seedRating snapshots and the bracket links, never live users.rating', async () => {
      const creator = await createUser('user', 1500);
      const t = await createTournament(creator.id, 4);
      const players = [await createUser('user', 1900), await createUser('user', 1700), creator];
      for (const p of players) await service.join(p.id, t.id);
      await service.closeRegistration(creator.id, t.id);

      // Live rating changes after the close must not show up.
      await prisma.user.update({ where: { id: players[0].id }, data: { rating: 2500 } });
      const detail = await service.detail(t.id);

      assert.equal(detail.status, 'IN_PROGRESS');
      assert.deepEqual(detail.participants.map((p) => [p.userId, p.seed, p.seedRating]), [
        [players[0].id, 1, 1900], [players[1].id, 2, 1700], [creator.id, 3, 1500],
      ]);
      assert.equal(detail.participants[0].username, players[0].username);
      assert.equal(detail.matches.length, 3);
      const final = detail.matches.find((m) => m.round === 2)!;
      for (const m of detail.matches.filter((x) => x.round === 1)) {
        assert.equal(m.nextMatchId, final.id);
        assert.ok(m.nextMatchSlot === 'player1' || m.nextMatchSlot === 'player2');
        assert.deepEqual(m.gameIds, []);
        assert.equal(m.currentGameId, null);
      }
      assert.ok(!JSON.stringify(detail).includes('"rating"'));
      assert.ok(!JSON.stringify(detail).includes('2500'));
    });

    it('returns 404 for an unknown id', async () => {
      await expectError(service.detail(randomUUID()), 404, 'TOURNAMENT_NOT_FOUND');
    });
  });
});
