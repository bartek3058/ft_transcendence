import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../../src/database/prisma.service';
import { GameService } from '../../src/game/game.service';
import { RatingService } from '../../src/rating/rating.service';
import { TournamentHttpError } from '../../src/tournament/http/tournament.errors';
import { TournamentBracketService } from '../../src/tournament/tournament-bracket.service';
import { TournamentCheckInService } from '../../src/tournament/tournament-check-in.service';
import { MAX_SWEEP_ATTEMPTS, TournamentCheckInSweeper } from '../../src/tournament/tournament-check-in.sweeper';
import { TournamentEventsPublisher } from '../../src/tournament/tournament-events.publisher';
import { TournamentGameService } from '../../src/tournament/tournament-game.service';
import { TournamentLifecycleService } from '../../src/tournament/tournament-lifecycle.service';
import { TOURNAMENT_CHECK_IN_WINDOW_MS } from '../../src/tournament/tournament-rules';
import { requireTestDatabaseUrl } from '../test-database-url';

/* Real PostgreSQL test for match check-in: server-set deadlines, the
conditional check-in UPDATE, concurrent check-ins, check-in vs deadline sweep,
walkover / double-forfeit resolution and the final-round guard.
*/
Logger.overrideLogger(['error']);

const prisma = new PrismaService({
  datasources: { db: { url: requireTestDatabaseUrl(process.env.TEST_DATABASE_URL) } },
});
const bracket = new TournamentBracketService(prisma);
const publisher = new TournamentEventsPublisher();
const tournamentGames = new TournamentGameService(prisma, new GameService(prisma, new RatingService(prisma)), bracket, publisher);
const lifecycle = new TournamentLifecycleService(prisma, bracket, publisher);
const checkIns = new TournamentCheckInService(prisma, tournamentGames, publisher);
const newSweeper = () => new TournamentCheckInSweeper(prisma, bracket, tournamentGames, publisher);

const userIds: string[] = [];
const tournamentIds: string[] = [];
const MINUTE = 60_000;

async function createUser(rating = 1200) {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const user = await prisma.user.create({ data: {
    email: `t161_${suffix}@example.test`, username: `t161_${suffix}`, rating,
    passwordHash: '$argon2id$test-fixture-not-a-real-password',
  } });
  userIds.push(user.id);
  return user;
}

// An IN_PROGRESS tournament with a generated bracket; players[0] is the best seed.
async function startedTournament(playerCount: number) {
  const players = [];
  for (let i = 0; i < playerCount; i++) players.push(await createUser(2000 - i * 100));
  const tournament = await prisma.tournament.create({ data: {
    title: `t161 ${randomUUID().slice(0, 8)}`, creatorId: players[0].id, maxParticipants: 8,
    currentParticipants: playerCount, registrationDeadline: new Date(Date.now() + 10 * MINUTE),
  } });
  tournamentIds.push(tournament.id);
  for (let i = 0; i < playerCount; i++) {
    await prisma.tournamentParticipant.create({ data: {
      tournamentId: tournament.id, userId: players[i].id, registeredAt: new Date(1000 + i),
    } });
  }
  assert.equal(await lifecycle.closeAndStart(tournament.id, 'MANUAL'), 'IN_PROGRESS');
  return { tournamentId: tournament.id, players };
}

const matchOf = (tournamentId: string, identifier: string) =>
  prisma.tournamentMatch.findFirstOrThrow({ where: { tournamentId, identifier } });
const matchById = (id: string) => prisma.tournamentMatch.findUniqueOrThrow({ where: { id } });
const expire = (matchId: string) =>
  prisma.tournamentMatch.update({ where: { id: matchId }, data: { checkInDeadline: new Date(Date.now() - MINUTE) } });
const gamesOf = (matchId: string) => prisma.game.count({ where: { tournamentMatchId: matchId } });

async function expectError(promise: Promise<unknown>, status: number, code: string) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof TournamentHttpError, `expected TournamentHttpError, got ${String(err)}`);
    assert.equal(err.getStatus(), status);
    assert.equal((err.getResponse() as { error: { code: string } }).error.code, code);
    return true;
  });
}

function assertFreshDeadline(deadline: Date | null, before: number, afterMs: number) {
  assert.ok(deadline, 'deadline must be set');
  assert.ok(deadline.getTime() >= before + TOURNAMENT_CHECK_IN_WINDOW_MS - 1000);
  assert.ok(deadline.getTime() <= afterMs + TOURNAMENT_CHECK_IN_WINDOW_MS + 1000);
}

describe('Tournament match check-in against PostgreSQL (#161)', () => {
  before(async () => { await prisma.$connect(); });

  after(async () => {
    try {
      // Fixtures only (dedicated *_test database): games first (no cascade), then tournaments, then users.
      await prisma.game.deleteMany({ where: { tournamentId: { in: tournamentIds } } });
      await prisma.tournament.deleteMany({ where: { id: { in: tournamentIds } } });
      await prisma.game.deleteMany({ where: { OR: [{ whiteId: { in: userIds } }, { blackId: { in: userIds } }] } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } finally {
      await prisma.$disconnect();
    }
  });

  describe('deadlines', () => {
    it('every SCHEDULED match gets a 5 minute deadline at bracket generation, others none', async () => {
      const before = Date.now();
      const { tournamentId } = await startedTournament(5); // 8-bracket, 3 byes: a Round 2 match is full at once
      const afterMs = Date.now();
      const matches = await prisma.tournamentMatch.findMany({ where: { tournamentId } });
      for (const m of matches) {
        if (m.status === 'SCHEDULED') assertFreshDeadline(m.checkInDeadline, before, afterMs);
        else assert.equal(m.checkInDeadline, null, `${m.identifier} (${m.status}) must have no deadline`);
      }
      assert.ok(matches.some((m) => m.round === 2 && m.status === 'SCHEDULED'), 'a Round 2 match filled by byes');
    });

    it('a match that becomes SCHEDULED through progression gets a fresh deadline', async () => {
      const { tournamentId } = await startedTournament(4);
      const m1 = await matchOf(tournamentId, 'R1-M1');
      const m2 = await matchOf(tournamentId, 'R1-M2');
      await prisma.$transaction((tx) => bracket.advanceWinner(tx, tournamentId, m1.id, m1.player1Id!));
      assert.equal((await matchById(m1.nextMatchId!)).checkInDeadline, null);
      const before = Date.now();
      await prisma.$transaction((tx) => bracket.advanceWinner(tx, tournamentId, m2.id, m2.player2Id!));
      const final = await matchById(m1.nextMatchId!);
      assert.equal(final.status, 'SCHEDULED');
      assertFreshDeadline(final.checkInDeadline, before, Date.now());
    });
  });

  describe('check-in', () => {
    it('first check-in waits; the second starts the game with player1 as White', async () => {
      const { tournamentId } = await startedTournament(2);
      const m = await matchOf(tournamentId, 'R1-M1');
      const first = await checkIns.checkIn(m.player1Id!, tournamentId, m.id);
      assert.deepEqual([first.status, first.player1CheckedIn, first.player2CheckedIn, first.gameId], ['SCHEDULED', true, false, null]);
      const second = await checkIns.checkIn(m.player2Id!, tournamentId, m.id);
      assert.equal(second.status, 'IN_PROGRESS');
      assert.ok(second.gameId);
      const game = await prisma.game.findUniqueOrThrow({ where: { id: second.gameId! } });
      assert.deepEqual([game.whiteId, game.blackId, game.result], [m.player1Id, m.player2Id, 'IN_PROGRESS']);
    });

    it('a repeated check-in returns the current state (idempotent)', async () => {
      const { tournamentId } = await startedTournament(2);
      const m = await matchOf(tournamentId, 'R1-M1');
      const first = await checkIns.checkIn(m.player1Id!, tournamentId, m.id);
      assert.deepEqual(await checkIns.checkIn(m.player1Id!, tournamentId, m.id), first);
      const started = await checkIns.checkIn(m.player2Id!, tournamentId, m.id);
      assert.deepEqual(await checkIns.checkIn(m.player2Id!, tournamentId, m.id), started);
      assert.deepEqual(await checkIns.checkIn(m.player1Id!, tournamentId, m.id), started);
      assert.equal(await gamesOf(m.id), 1);
    });

    it('403 for a non-player, 404 for an unknown match or one from another tournament', async () => {
      const { tournamentId } = await startedTournament(2);
      const other = await startedTournament(2);
      const m = await matchOf(tournamentId, 'R1-M1');
      const stranger = await createUser();
      await expectError(checkIns.checkIn(stranger.id, tournamentId, m.id), 403, 'NOT_MATCH_PLAYER');
      await expectError(checkIns.checkIn(m.player1Id!, tournamentId, randomUUID()), 404, 'MATCH_NOT_FOUND');
      await expectError(checkIns.checkIn(m.player1Id!, other.tournamentId, m.id), 404, 'MATCH_NOT_FOUND');
    });

    it('409 after the deadline, for a PENDING match and outside a live tournament', async () => {
      const { tournamentId } = await startedTournament(4);
      const m1 = await matchOf(tournamentId, 'R1-M1');
      await expire(m1.id);
      await expectError(checkIns.checkIn(m1.player1Id!, tournamentId, m1.id), 409, 'CHECK_IN_CLOSED');
      assert.equal((await matchById(m1.id)).player1CheckedInAt, null);

      const m2 = await matchOf(tournamentId, 'R1-M2');
      await prisma.$transaction((tx) => bracket.advanceWinner(tx, tournamentId, m2.id, m2.player1Id!));
      const final = await matchById(m2.nextMatchId!);
      await expectError(checkIns.checkIn(m2.player1Id!, tournamentId, final.id), 409, 'MATCH_NOT_SCHEDULED');

      await prisma.tournament.update({ where: { id: tournamentId }, data: { status: 'FINISHED' } });
      const m1b = await prisma.tournamentMatch.update({
        where: { id: m1.id }, data: { checkInDeadline: new Date(Date.now() + MINUTE) },
      });
      await expectError(checkIns.checkIn(m1b.player1Id!, tournamentId, m1b.id), 409, 'TOURNAMENT_NOT_IN_PROGRESS');
    });

    it('both players checking in at once start exactly one game', async () => {
      for (let round = 0; round < 5; round++) {
        const { tournamentId } = await startedTournament(2);
        const m = await matchOf(tournamentId, 'R1-M1');
        const [a, b] = await Promise.all([
          checkIns.checkIn(m.player1Id!, tournamentId, m.id),
          checkIns.checkIn(m.player2Id!, tournamentId, m.id),
        ]);
        assert.equal(await gamesOf(m.id), 1);
        assert.equal((await matchById(m.id)).status, 'IN_PROGRESS');
        // Only the transaction that saw both check-ins started the game.
        assert.equal([a, b].filter((s) => s.status === 'IN_PROGRESS' && s.gameId).length, 1);
      }
    });
  });

  describe('deadline sweep', () => {
    it('one player checked in -> walkover; the winner advances into the next match', async () => {
      const { tournamentId } = await startedTournament(4);
      const m = await matchOf(tournamentId, 'R1-M1');
      await checkIns.checkIn(m.player2Id!, tournamentId, m.id);
      await expire(m.id);
      assert.equal(await newSweeper().resolve(tournamentId, m.id), 'WALKOVER');
      const done = await matchById(m.id);
      assert.deepEqual([done.status, done.winnerId], ['WALKOVER', m.player2Id]);
      const next = await matchById(m.nextMatchId!);
      assert.equal(m.nextMatchSlot === 'player1' ? next.player1Id : next.player2Id, m.player2Id);
      assert.equal(await gamesOf(m.id), 0);
    });

    it('nobody checked in anywhere -> double forfeits cascade and the tournament ends without a champion', async () => {
      const { tournamentId } = await startedTournament(4);
      const m1 = await matchOf(tournamentId, 'R1-M1');
      const m2 = await matchOf(tournamentId, 'R1-M2');
      await expire(m1.id);
      await expire(m2.id);
      const sweeper = newSweeper();
      assert.equal(await sweeper.resolve(tournamentId, m1.id), 'DOUBLE_FORFEIT');
      assert.equal(await sweeper.resolve(tournamentId, m2.id), 'DOUBLE_FORFEIT');
      const final = await matchById(m1.nextMatchId!);
      assert.deepEqual([final.status, final.winnerId], ['WALKOVER', null]);
      const t = await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } });
      assert.deepEqual([t.status, t.championId], ['FINISHED', null]);
    });

    it('both checked in but no game (older data) -> the sweep starts the game', async () => {
      const { tournamentId } = await startedTournament(2);
      const m = await matchOf(tournamentId, 'R1-M1');
      await prisma.tournamentMatch.update({ where: { id: m.id }, data: {
        player1CheckedInAt: new Date(), player2CheckedInAt: new Date(), checkInDeadline: new Date(Date.now() - MINUTE),
      } });
      assert.equal(await newSweeper().resolve(tournamentId, m.id), 'STARTED');
      assert.equal((await matchById(m.id)).status, 'IN_PROGRESS');
      assert.equal(await gamesOf(m.id), 1);
    });

    it('a check-in racing the sweep at the deadline ends in exactly one outcome', async () => {
      for (let round = 0; round < 10; round++) {
        const { tournamentId } = await startedTournament(2);
        const m = await matchOf(tournamentId, 'R1-M1');
        await checkIns.checkIn(m.player1Id!, tournamentId, m.id);
        // Deadline a few ms ahead: either side may win depending on timing.
        await prisma.tournamentMatch.update({ where: { id: m.id }, data: { checkInDeadline: new Date(Date.now() + 20) } });
        await new Promise((resolve) => setTimeout(resolve, 10 + (round % 4) * 5));
        await Promise.allSettled([
          checkIns.checkIn(m.player2Id!, tournamentId, m.id),
          newSweeper().resolve(tournamentId, m.id),
        ]);
        await newSweeper().resolve(tournamentId, m.id); // settle a sweep that ran too early
        const done = await matchById(m.id);
        const games = await gamesOf(m.id);
        if (done.status === 'IN_PROGRESS') {
          assert.equal(games, 1);
          assert.equal(done.winnerId, null);
        } else {
          assert.deepEqual([done.status, done.winnerId, games], ['WALKOVER', m.player1Id, 0]);
        }
      }
    });

    it(`stops retrying a match with inconsistent data after ${MAX_SWEEP_ATTEMPTS} failures, forfeiting nobody`, async () => {
      const { tournamentId, players } = await startedTournament(4);
      const m = await matchOf(tournamentId, 'R1-M1');
      await checkIns.checkIn(m.player1Id!, tournamentId, m.id);
      await expire(m.id);
      // Corrupt: the slot this match feeds is already taken.
      const intruder = players.find((p) => p.id !== m.player1Id && p.id !== m.player2Id)!;
      await prisma.tournamentMatch.update({
        where: { id: m.nextMatchId! },
        data: m.nextMatchSlot === 'player1' ? { player1Id: intruder.id } : { player2Id: intruder.id },
      });
      const sweeper = newSweeper();
      for (let i = 1; i <= MAX_SWEEP_ATTEMPTS + 2; i++) {
        await sweeper.tick();
        const now = await matchById(m.id);
        assert.deepEqual([now.status, now.winnerId], ['SCHEDULED', null]); // every attempt rolled back
      }
      const quarantined = (sweeper as unknown as { quarantined: Set<string> }).quarantined;
      assert.ok(quarantined.has(m.id));
      assert.equal((await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } })).status, 'IN_PROGRESS');
    });

    it('ignores matches of tournaments that are not in progress', async () => {
      const { tournamentId } = await startedTournament(2);
      const m = await matchOf(tournamentId, 'R1-M1');
      await expire(m.id);
      await prisma.tournament.update({ where: { id: tournamentId }, data: { status: 'FINISHED' } });
      await newSweeper().tick();
      assert.equal((await matchById(m.id)).status, 'SCHEDULED');
    });
  });

  describe('final-round guard (#68 hardening)', () => {
    it('a match without a next match that is not the Final cannot finish the tournament', async () => {
      const { tournamentId } = await startedTournament(4);
      const m = await matchOf(tournamentId, 'R1-M1');
      await prisma.tournamentMatch.update({ where: { id: m.id }, data: { nextMatchId: null } }); // lost link
      await assert.rejects(
        prisma.$transaction((tx) => bracket.advanceWinner(tx, tournamentId, m.id, m.player1Id!)),
        (err: unknown) => (err as { status?: number }).status === 409,
      );
      const t = await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } });
      assert.deepEqual([t.status, t.championId], ['IN_PROGRESS', null]);
      assert.equal((await matchById(m.id)).status, 'SCHEDULED'); // rolled back
    });
  });
});
