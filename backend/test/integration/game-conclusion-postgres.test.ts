import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../src/database/prisma.service';
import { RatingService } from '../../src/rating/rating.service';
import { GameService } from '../../src/game/game.service';
import { requireTestDatabaseUrl } from '../test-database-url';

/* Real PostgreSQL integration test for GameService.removeGame (#143):
result / end_reason / game_end land in 'games' and the Elo update is applied atomically.
*/
const prisma = new PrismaService({
  datasources: { db: { url: requireTestDatabaseUrl(process.env.TEST_DATABASE_URL) } },
});
const rating = new RatingService(prisma);
const userIds: string[] = [];
const gameIds: string[] = [];

async function createPlayer(startRating: number) {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const user = await prisma.user.create({ data: {
    email: `g143_${suffix}@example.test`, username: `g143_${suffix}`,
    passwordHash: '$argon2id$test-fixture-not-a-real-password', rating: startRating,
  } });
  userIds.push(user.id);
  return user;
}

/* Mirrors MatchmakingService.createMatch: an IN_PROGRESS row with the pre-game ratings,
plus the in-memory session under the same UUID.
*/
async function startGame(service: GameService, initialFen?: string) {
  const white = await createPlayer(1500);
  const black = await createPlayer(1500);
  const gameId = randomUUID();
  gameIds.push(gameId);
  await prisma.game.create({ data: {
    id: gameId, whiteId: white.id, blackId: black.id,
    whiteRating: white.rating, blackRating: black.rating, result: 'IN_PROGRESS',
  } });
  service.createGame({ gameId, whitePlayerId: white.id, blackPlayerId: black.id, initialFen });
  return { gameId, white, black };
}

describe('GameService.removeGame against PostgreSQL (#143)', () => {
  before(async () => { await prisma.$connect(); });

  after(async () => {
    try {
      // Test fixtures only (dedicated *_test database).
      await prisma.game.deleteMany({ where: { id: { in: gameIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } finally {
      await prisma.$disconnect();
    }
  });

  it('persists a checkmate and applies the Elo update in the same flow', async () => {
    const service = new GameService(prisma, rating);
    const { gameId, white, black } = await startGame(service);
    // Fool's mate: black wins.
    const moves: [string, string][] = [['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']];
    moves.forEach(([from, to], i) => {
      const res = service.executeMove({ gameId, from, to } as any, i % 2 === 0 ? white.id : black.id);
      assert.equal(res.success, true);
    });

    const before = Date.now();
    assert.equal(await service.removeGame(gameId), true);

    const game = await prisma.game.findUniqueOrThrow({ where: { id: gameId } });
    assert.equal(game.result, 'BLACK_WON');
    assert.equal(game.endReason, 'CHECKMATE');
    assert.ok(game.gameEnd, 'game_end must be set');
    assert.ok(game.gameEnd!.getTime() >= before - 1000);
    assert.equal(game.whiteRating, 1500, 'pre-game snapshot kept');
    assert.equal(game.blackRating, 1500);
    assert.ok(game.whiteRatingChange! < 0, 'loser loses rating');
    assert.ok(game.blackRatingChange! > 0, 'winner gains rating');

    const [w, b] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: white.id } }),
      prisma.user.findUniqueOrThrow({ where: { id: black.id } }),
    ]);
    assert.equal(w.rating, 1500 + game.whiteRatingChange!);
    assert.equal(b.rating, 1500 + game.blackRatingChange!);
    assert.equal(service.hasActiveGame(gameId), false);
  });

  it('persists a resignation passed by the caller', async () => {
    const service = new GameService(prisma, rating);
    const { gameId } = await startGame(service);
    assert.equal(await service.removeGame(gameId, { winnerColor: 'w', gameOverReason: 'RESIGNATION' }), true);
    const game = await prisma.game.findUniqueOrThrow({ where: { id: gameId } });
    assert.equal(game.result, 'WHITE_WON');
    assert.equal(game.endReason, 'RESIGNATION');
    assert.ok(game.whiteRatingChange! > 0);
  });

  it('persists a draw (stalemate) with equal-rating Elo change of 0', async () => {
    const service = new GameService(prisma, rating);
    const { gameId } = await startGame(service, '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
    assert.equal(await service.removeGame(gameId), true);
    const game = await prisma.game.findUniqueOrThrow({ where: { id: gameId } });
    assert.equal(game.result, 'DRAW');
    assert.equal(game.endReason, 'STALEMATE');
    assert.equal(game.whiteRatingChange, 0);
    assert.equal(game.blackRatingChange, 0);
  });

  it('stores an unfinished game as ABORTED without touching ratings', async () => {
    const service = new GameService(prisma, rating);
    const { gameId, white } = await startGame(service);
    assert.equal(await service.removeGame(gameId), true);
    const game = await prisma.game.findUniqueOrThrow({ where: { id: gameId } });
    assert.equal(game.result, 'ABORTED');
    assert.equal(game.endReason, null);
    assert.equal(game.whiteRatingChange, null);
    const w = await prisma.user.findUniqueOrThrow({ where: { id: white.id } });
    assert.equal(w.rating, 1500);
  });

  it('never overwrites or re-rates an already concluded game', async () => {
    const first = new GameService(prisma, rating);
    const { gameId, white, black } = await startGame(first);
    await first.removeGame(gameId, { winnerColor: 'w', gameOverReason: 'TIMEOUT' });
    const afterFirst = await prisma.user.findUniqueOrThrow({ where: { id: white.id } });

    // A second, stale session for the same id (e.g. another instance) tries to close it again.
    const second = new GameService(prisma, rating);
    second.createGame({ gameId, whitePlayerId: white.id, blackPlayerId: black.id });
    await second.removeGame(gameId, { winnerColor: 'b', gameOverReason: 'RESIGNATION' });

    const game = await prisma.game.findUniqueOrThrow({ where: { id: gameId } });
    assert.equal(game.result, 'WHITE_WON');
    assert.equal(game.endReason, 'TIMEOUT');
    const afterSecond = await prisma.user.findUniqueOrThrow({ where: { id: white.id } });
    assert.equal(afterSecond.rating, afterFirst.rating, 'no double rating');
  });
});
