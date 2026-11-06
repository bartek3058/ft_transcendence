import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../src/database/prisma.service';
import { RatingService } from '../../src/rating/rating.service';
import { GameService } from '../../src/game/game.service';
import { TournamentBracketService } from '../../src/tournament/tournament-bracket.service';
import { TournamentGameService } from '../../src/tournament/tournament-game.service';
import { requireTestDatabaseUrl } from '../test-database-url';

// Real PostgreSQL integration test for the tournament engine (#68):
// unique indexes, conditional status transitions under concurrency, the
// one-live-game-per-match partial index and the GameService -> bracket hook.
// In-memory mocks cannot prove any of this (constitution: "No Mock Blindness").
const prisma = new PrismaService({
  datasources: { db: { url: requireTestDatabaseUrl(process.env.TEST_DATABASE_URL) } },
});
const rating = new RatingService(prisma);
const bracket = new TournamentBracketService(prisma);

const userIds: string[] = [];
const tournamentIds: string[] = [];

async function createPlayer(startRating: number) {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const user = await prisma.user.create({ data: {
    email: `t68_${suffix}@example.test`, username: `t68_${suffix}`,
    passwordHash: '$argon2id$test-fixture-not-a-real-password', rating: startRating,
  } });
  userIds.push(user.id);
  return user;
}

/** Creates a REGISTRATION_CLOSED tournament; players[0] is the best seed. */
async function createTournament(playerCount: number) {
  const players = [];
  for (let i = 0; i < playerCount; i++) {
    players.push(await createPlayer(2000 - i * 100));
  }
  const tournament = await prisma.tournament.create({ data: {
    title: `t68 ${randomUUID().slice(0, 8)}`,
    creatorId: players[0].id,
    maxParticipants: 8,
    currentParticipants: playerCount,
    status: 'REGISTRATION_CLOSED',
    registrationDeadline: new Date(Date.now() - 60_000),
  } });
  tournamentIds.push(tournament.id);
  for (let i = 0; i < playerCount; i++) {
    await prisma.tournamentParticipant.create({ data: {
      tournamentId: tournament.id, userId: players[i].id, registeredAt: new Date(1000 + i),
    } });
  }
  return { tournamentId: tournament.id, players };
}

async function start(tournamentId: string) {
  return prisma.$transaction((tx) => bracket.generateAndSaveBracket(tx, tournamentId));
}

async function matchByIdentifier(tournamentId: string, identifier: string) {
  return prisma.tournamentMatch.findFirstOrThrow({ where: { tournamentId, identifier } });
}

function statusOf(err: unknown): number | undefined {
  return (err as { status?: number })?.status;
}

describe('Tournament engine against PostgreSQL (#68)', () => {
  before(async () => { await prisma.$connect(); });

  after(async () => {
    try {
      // Test fixtures only (dedicated *_test database). Games first (no cascade),
      // then tournaments (cascade participants/matches), then users.
      await prisma.game.deleteMany({ where: { tournamentId: { in: tournamentIds } } });
      await prisma.tournament.deleteMany({ where: { id: { in: tournamentIds } } });
      await prisma.game.deleteMany({
        where: { OR: [{ whiteId: { in: userIds } }, { blackId: { in: userIds } }] },
      });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } finally {
      await prisma.$disconnect();
    }
  });

  it('persists the bracket, seeds and frozen seed ratings in one transaction', async () => {
    const { tournamentId, players } = await createTournament(3);
    const generated = await start(tournamentId);

    assert.equal(generated.bracketSize, 4);
    const tournament = await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } });
    assert.equal(tournament.status, 'IN_PROGRESS');
    assert.ok(tournament.startedAt);

    const participants = await prisma.tournamentParticipant.findMany({
      where: { tournamentId }, orderBy: { seed: 'asc' },
    });
    assert.deepEqual(participants.map((p) => p.userId), players.map((p) => p.id));
    assert.deepEqual(participants.map((p) => p.seedRating), [2000, 1900, 1800]);

    const matches = await prisma.tournamentMatch.findMany({ where: { tournamentId } });
    assert.equal(matches.length, 3);
    const final = matches.find((m) => m.identifier === 'R2-M1')!;
    assert.equal(final.player1Id, players[0].id, 'bye winner placed in the Final');
    assert.equal(final.status, 'PENDING');
  });

  it('a second start is rejected with 409 and leaves the bracket untouched', async () => {
    const { tournamentId } = await createTournament(4);
    await start(tournamentId);
    await assert.rejects(start(tournamentId), (err) => statusOf(err) === 409);
    assert.equal(await prisma.tournamentMatch.count({ where: { tournamentId } }), 3);
  });

  it('two concurrent starts produce exactly one bracket', async () => {
    const { tournamentId } = await createTournament(4);
    const results = await Promise.allSettled([start(tournamentId), start(tournamentId)]);

    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.equal(statusOf(rejected.reason), 409);
    assert.equal(await prisma.tournamentMatch.count({ where: { tournamentId } }), 3);
  });

  it('a concurrent win and walkover on the same match advance exactly one player', async () => {
    const { tournamentId, players } = await createTournament(4);
    await start(tournamentId);
    const sf1 = await matchByIdentifier(tournamentId, 'R1-M1'); // seed 1 vs seed 4
    const [p1, p4] = [players[0].id, players[3].id];

    const results = await Promise.allSettled([
      prisma.$transaction((tx) => bracket.advanceWinner(tx, tournamentId, sf1.id, p4)),
      prisma.$transaction((tx) => bracket.handleWalkover(tx, tournamentId, sf1.id, p4)),
    ]);

    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.equal(statusOf(rejected.reason), 409);

    const closed = await prisma.tournamentMatch.findUniqueOrThrow({ where: { id: sf1.id } });
    const final = await matchByIdentifier(tournamentId, 'R2-M1');
    assert.ok(closed.winnerId === p4 || closed.winnerId === p1);
    assert.equal(final.player1Id, closed.winnerId, 'Final slot matches the recorded winner');
  });

  it('both semifinals finishing concurrently schedule the Final', async () => {
    const { tournamentId, players } = await createTournament(4);
    await start(tournamentId);
    const sf1 = await matchByIdentifier(tournamentId, 'R1-M1');
    const sf2 = await matchByIdentifier(tournamentId, 'R1-M2');

    await Promise.all([
      prisma.$transaction((tx) => bracket.advanceWinner(tx, tournamentId, sf1.id, players[0].id)),
      prisma.$transaction((tx) => bracket.advanceWinner(tx, tournamentId, sf2.id, players[1].id)),
    ]);

    const final = await matchByIdentifier(tournamentId, 'R2-M1');
    assert.equal(final.player1Id, players[0].id);
    assert.equal(final.player2Id, players[1].id);
    assert.equal(final.status, 'SCHEDULED');
  });

  it('the partial unique index allows only one live game per match', async () => {
    const { tournamentId, players } = await createTournament(2);
    await start(tournamentId);
    const final = await matchByIdentifier(tournamentId, 'R1-M1');
    const live = {
      whiteId: players[0].id, blackId: players[1].id,
      result: 'IN_PROGRESS', tournamentId, tournamentMatchId: final.id,
    };

    await prisma.game.create({ data: { id: randomUUID(), ...live } });
    await assert.rejects(
      prisma.game.create({ data: { id: randomUUID(), ...live } }),
      (err: any) => err.code === 'P2002',
    );
    // A finished game for the same match is allowed (history of replays).
    await prisma.game.create({ data: { id: randomUUID(), ...live, result: 'DRAW' } });
  });

  it('end to end: finished games drive the bracket, draws replay with swapped colors', async () => {
    const { tournamentId, players } = await createTournament(4);
    await start(tournamentId);
    const games = new GameService(prisma, rating);
    const tournamentGames = new TournamentGameService(prisma, games, bracket);
    tournamentGames.onModuleInit();

    const [s1, s2, s3, s4] = players.map((p) => p.id);
    const sf1 = await matchByIdentifier(tournamentId, 'R1-M1'); // s1 vs s4
    const sf2 = await matchByIdentifier(tournamentId, 'R1-M2'); // s2 vs s3

    // SF1: decisive result (s4 resigns) -> s1 advances.
    const g1 = await tournamentGames.startMatchGame(tournamentId, sf1.id);
    assert.equal(g1.whitePlayerId, s1);
    assert.equal((await prisma.tournamentMatch.findUniqueOrThrow({ where: { id: sf1.id } })).status, 'IN_PROGRESS');
    assert.equal(await games.removeGame(g1.gameId, { winnerColor: 'w', gameOverReason: 'RESIGNATION' }), true);

    let final = await matchByIdentifier(tournamentId, 'R2-M1');
    assert.equal(final.player1Id, s1);
    assert.equal(final.status, 'PENDING');

    // SF2: three draws -> two replays with swapped colors, then the better seed (s2) advances.
    let current = await tournamentGames.startMatchGame(tournamentId, sf2.id);
    const colors: string[] = [];
    for (let i = 0; i < 3; i++) {
      colors.push(current.whitePlayerId);
      assert.equal(await games.removeGame(current.gameId, { winnerColor: null, gameOverReason: 'STALEMATE' }), true);
      if (i < 2) {
        const next = await prisma.game.findFirstOrThrow({
          where: { tournamentMatchId: sf2.id, result: 'IN_PROGRESS' },
        });
        assert.ok(games.hasActiveGame(next.id), 'replay session started');
        current = { ...current, gameId: next.id, whitePlayerId: next.whiteId!, blackPlayerId: next.blackId! };
      }
    }
    assert.deepEqual(colors, [s2, s3, s2], 'colors swap on every replay');
    assert.equal(await prisma.game.count({ where: { tournamentMatchId: sf2.id } }), 3);
    assert.equal(await prisma.game.count({ where: { tournamentMatchId: sf2.id, result: 'IN_PROGRESS' } }), 0);

    const sf2Closed = await prisma.tournamentMatch.findUniqueOrThrow({ where: { id: sf2.id } });
    assert.equal(sf2Closed.status, 'COMPLETED');
    assert.equal(sf2Closed.winnerId, s2);

    final = await matchByIdentifier(tournamentId, 'R2-M1');
    assert.equal(final.player2Id, s2);
    assert.equal(final.status, 'SCHEDULED');

    // Final: s2 wins on time -> champion and ranks.
    const gf = await tournamentGames.startMatchGame(tournamentId, final.id);
    assert.equal(gf.whitePlayerId, s1);
    assert.equal(await games.removeGame(gf.gameId, { winnerColor: 'b', gameOverReason: 'TIMEOUT' }), true);

    const done = await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } });
    assert.equal(done.status, 'FINISHED');
    assert.equal(done.championId, s2);
    const ranks = Object.fromEntries(
      (await prisma.tournamentParticipant.findMany({ where: { tournamentId } }))
        .map((p) => [p.userId, p.finalRank]),
    );
    assert.deepEqual(ranks, { [s1]: 2, [s2]: 1, [s3]: 3, [s4]: 3 });
  });

  it('a duplicate conclusion of the same game does not advance twice', async () => {
    const { tournamentId, players } = await createTournament(2);
    await start(tournamentId);
    const games = new GameService(prisma, rating);
    const tournamentGames = new TournamentGameService(prisma, games, bracket);
    tournamentGames.onModuleInit();
    const final = await matchByIdentifier(tournamentId, 'R1-M1');

    const g = await tournamentGames.startMatchGame(tournamentId, final.id);
    await games.removeGame(g.gameId, { winnerColor: 'w', gameOverReason: 'CHECKMATE' });
    // Replay the listener directly, as a retry would: must be a logged no-op.
    await tournamentGames.handleGameConcluded({
      gameId: g.gameId, result: 'BLACK_WON', endReason: 'RESIGNATION',
      whitePlayerId: players[0].id, blackPlayerId: players[1].id,
    });

    const done = await prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId } });
    assert.equal(done.championId, players[0].id, 'first result stands');
  });
});
