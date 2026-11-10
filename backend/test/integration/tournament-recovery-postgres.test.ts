import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../../src/database/prisma.service';
import { GameService } from '../../src/game/game.service';
import { RatingService } from '../../src/rating/rating.service';
import { TournamentBracketService } from '../../src/tournament/tournament-bracket.service';
import { TournamentCheckInService } from '../../src/tournament/tournament-check-in.service';
import { TournamentEventsPublisher } from '../../src/tournament/tournament-events.publisher';
import { TournamentGameService } from '../../src/tournament/tournament-game.service';
import { TournamentLifecycleService } from '../../src/tournament/tournament-lifecycle.service';
import {
  MAX_RECOVERY_ATTEMPTS, SERVER_RESTART_REASON, TournamentRecoveryService,
} from '../../src/tournament/tournament-recovery.service';
import { requireTestDatabaseUrl } from '../test-database-url';

/* Real PostgreSQL test for tournament recovery: a result whose listener 
never ran is applied exactly once; a restart (or an aborted game) sends the
match back to check-in; recent results are left to the listener; races give one outcome.
*/
Logger.overrideLogger(['error']);

const prisma = new PrismaService({
  datasources: { db: { url: requireTestDatabaseUrl(process.env.TEST_DATABASE_URL) } },
});
const publisher = new TournamentEventsPublisher();
const bracket = new TournamentBracketService(prisma);
const tournamentGames = new TournamentGameService(prisma, new GameService(prisma, new RatingService(prisma)), bracket, publisher);
const lifecycle = new TournamentLifecycleService(prisma, bracket, publisher);
const checkIns = new TournamentCheckInService(prisma, tournamentGames, publisher);
const newRecovery = () => new TournamentRecoveryService(prisma, tournamentGames, publisher);

const userIds: string[] = [];
const tournamentIds: string[] = [];
const MINUTE = 60_000;

async function createUser(rating: number) {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const user = await prisma.user.create({ data: {
    email: `t168r_${suffix}@example.test`, username: `t168r_${suffix}`, rating,
    passwordHash: '$argon2id$test-fixture-not-a-real-password',
  } });
  userIds.push(user.id);
  return user;
}

// IN_PROGRESS tournament whose match R1-M1 has a live game (both players checked in).
async function liveMatch(playerCount = 4) {
  const players = [];
  for (let i = 0; i < playerCount; i++) players.push(await createUser(2000 - i * 100));
  const t = await prisma.tournament.create({ data: {
    title: `t168r ${randomUUID().slice(0, 8)}`, creatorId: players[0].id, maxParticipants: 8,
    currentParticipants: playerCount, registrationDeadline: new Date(Date.now() + 10 * MINUTE),
  } });
  tournamentIds.push(t.id);
  for (let i = 0; i < playerCount; i++) {
    await prisma.tournamentParticipant.create({ data: { tournamentId: t.id, userId: players[i].id, registeredAt: new Date(1000 + i) } });
  }
  await lifecycle.closeAndStart(t.id, 'MANUAL');
  const m = await prisma.tournamentMatch.findFirstOrThrow({ where: { tournamentId: t.id, identifier: 'R1-M1' } });
  await checkIns.checkIn(m.player1Id!, t.id, m.id);
  const started = await checkIns.checkIn(m.player2Id!, t.id, m.id);
  return { tournamentId: t.id, match: m, gameId: started.gameId! };
}

/*
Moves a game's end into the past. game_start moves too, because the DB requires
game_end >= game_start (games_end_after_start_check).
*/
function endedAgo(endedMsAgo: number) {
  const gameEnd = new Date(Date.now() - endedMsAgo);
  return { gameStart: new Date(gameEnd.getTime() - MINUTE), gameEnd };
}

// What GameService writes when a game ends; the tournament listener is not run.
async function concludeWithoutListener(gameId: string, result: string, endReason: string | null, endedMsAgo = MINUTE) {
  await prisma.game.update({ where: { id: gameId }, data: { result, endReason, ...endedAgo(endedMsAgo) } });
}

const matchById = (id: string) => prisma.tournamentMatch.findUniqueOrThrow({ where: { id } });
const gamesOf = (matchId: string) => prisma.game.findMany({ where: { tournamentMatchId: matchId }, orderBy: { gameStart: 'asc' } });

function recordUpdates(tournamentId: string) {
  const ids: string[] = [];
  const stop = publisher.onMatchesUpdated((e) => { if (e.tournamentId === tournamentId) ids.push(...e.matchIds); });
  return { ids, stop };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe('Tournament recovery against PostgreSQL', () => {
  before(async () => { await prisma.$connect(); });

  after(async () => {
    try {
      await prisma.game.deleteMany({ where: { tournamentId: { in: tournamentIds } } });
      await prisma.tournament.deleteMany({ where: { id: { in: tournamentIds } } });
      await prisma.game.deleteMany({ where: { OR: [{ whiteId: { in: userIds } }, { blackId: { in: userIds } }] } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } finally {
      await prisma.$disconnect();
    }
  });

  it('applies a result whose listener never ran, exactly once', async () => {
    const { tournamentId, match, gameId } = await liveMatch();
    await concludeWithoutListener(gameId, 'WHITE_WON', 'CHECKMATE');
    const rec = recordUpdates(tournamentId);
    try {
      assert.equal((await newRecovery().tick()).failed, 0);
      await settle();
      const done = await matchById(match.id);
      assert.deepEqual([done.status, done.winnerId], ['COMPLETED', match.player1Id]); // player1 played White
      const next = await matchById(match.nextMatchId!);
      assert.equal(match.nextMatchSlot === 'player1' ? next.player1Id : next.player2Id, match.player1Id);
      assert.ok(rec.ids.includes(match.id) && rec.ids.includes(match.nextMatchId!));

      // A second recovery and a late listener call change nothing.
      await newRecovery().tick();
      await tournamentGames.handleGameConcluded({
        gameId, result: 'WHITE_WON', endReason: 'CHECKMATE', whitePlayerId: match.player1Id!, blackPlayerId: match.player2Id!,
      });
      const again = await matchById(match.nextMatchId!);
      assert.deepEqual([again.player1Id, again.player2Id], [next.player1Id, next.player2Id]);
    } finally {
      rec.stop();
    }
  });

  it('a draw whose listener never ran starts the replay with swapped colours', async () => {
    const { match, gameId } = await liveMatch();
    await concludeWithoutListener(gameId, 'DRAW', 'STALEMATE');
    await newRecovery().tick();
    const games = await gamesOf(match.id);
    assert.equal(games.length, 2);
    assert.deepEqual([games[1].result, games[1].whiteId, games[1].blackId], ['IN_PROGRESS', match.player2Id, match.player1Id]);
    assert.equal((await matchById(match.id)).status, 'IN_PROGRESS');
  });

  it('after a restart the interrupted game is aborted and the match goes back to check-in', async () => {
    const { tournamentId, match, gameId } = await liveMatch();
    assert.ok(await newRecovery().abortOrphanedGames() >= 1);
    const aborted = await prisma.game.findUniqueOrThrow({ where: { id: gameId } });
    assert.deepEqual([aborted.result, aborted.endReason], ['ABORTED', SERVER_RESTART_REASON]);

    await prisma.game.update({ where: { id: gameId }, data: endedAgo(MINUTE) });
    const rec = recordUpdates(tournamentId);
    const before = Date.now();
    try {
      assert.equal((await newRecovery().tick()).failed, 0);
      await settle();
    } finally {
      rec.stop();
    }
    const reopened = await matchById(match.id);
    assert.deepEqual([reopened.status, reopened.player1CheckedInAt, reopened.player2CheckedInAt], ['SCHEDULED', null, null]);
    assert.ok(reopened.checkInDeadline!.getTime() >= before + 5 * MINUTE - 1000);
    assert.ok(rec.ids.includes(match.id));

    // Playable again: both check in, a new game starts.
    await checkIns.checkIn(match.player1Id!, tournamentId, match.id);
    const restarted = await checkIns.checkIn(match.player2Id!, tournamentId, match.id);
    assert.equal(restarted.status, 'IN_PROGRESS');
    assert.notEqual(restarted.gameId, gameId);
    assert.equal((await gamesOf(match.id)).length, 2);
  });

  it('a game aborted without a restart is recovered the same way', async () => {
    const { match, gameId } = await liveMatch();
    await concludeWithoutListener(gameId, 'ABORTED', null);
    await newRecovery().tick();
    assert.equal((await matchById(match.id)).status, 'SCHEDULED');
  });

  it('leaves a recent result to the listener, then recovers it after the grace period', async () => {
    const { match, gameId } = await liveMatch();
    await concludeWithoutListener(gameId, 'BLACK_WON', 'RESIGNATION', 1000);
    await newRecovery().tick();
    assert.equal((await matchById(match.id)).status, 'IN_PROGRESS');
    await prisma.game.update({ where: { id: gameId }, data: endedAgo(MINUTE) });
    await newRecovery().tick();
    const done = await matchById(match.id);
    assert.deepEqual([done.status, done.winnerId], ['COMPLETED', match.player2Id]);
  });

  it('recovery racing the listener for the same game gives one result', async () => {
    for (let round = 0; round < 5; round++) {
      const { match, gameId } = await liveMatch();
      await concludeWithoutListener(gameId, 'WHITE_WON', 'CHECKMATE');
      await Promise.allSettled([
        newRecovery().tick(),
        tournamentGames.handleGameConcluded({
          gameId, result: 'WHITE_WON', endReason: 'CHECKMATE', whitePlayerId: match.player1Id!, blackPlayerId: match.player2Id!,
        }),
      ]);
      const done = await matchById(match.id);
      assert.deepEqual([done.status, done.winnerId], ['COMPLETED', match.player1Id]);
      const next = await matchById(match.nextMatchId!);
      const filled = [next.player1Id, next.player2Id].filter((id) => id === match.player1Id).length;
      assert.equal(filled, 1, `round ${round}: winner placed once`);
    }
  });

  it(`stops retrying a stuck match with inconsistent data after ${MAX_RECOVERY_ATTEMPTS} failures`, async () => {
    const { match, gameId } = await liveMatch();
    await concludeWithoutListener(gameId, 'WHITE_WON', 'CHECKMATE');
    // Corrupt: the slot the winner should fill is already taken.
    const intruder = await createUser(1000);
    await prisma.tournamentMatch.update({
      where: { id: match.nextMatchId! },
      data: match.nextMatchSlot === 'player1' ? { player1Id: intruder.id } : { player2Id: intruder.id },
    });
    const recovery = newRecovery();
    for (let i = 0; i < MAX_RECOVERY_ATTEMPTS + 2; i++) {
      await recovery.tick();
      const now = await matchById(match.id);
      assert.deepEqual([now.status, now.winnerId], ['IN_PROGRESS', null]); // every attempt rolled back
    }
    assert.ok((recovery as unknown as { quarantined: Set<string> }).quarantined.has(match.id));
  });
});
