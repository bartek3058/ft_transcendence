// Integration test: GameService cold-path persistence against a REAL PostgreSQL.
// In-memory fakes cannot prove FK / UNIQUE / CHECK / UUID behaviour (project rule:
// "No Mock Blindness"), so this runs the real GameService with the real PrismaService.
//
// Usage: TEST_DATABASE_URL=postgresql://chess_app:...@host/xxx_test npm run test:game-moves:db
require('reflect-metadata');
require('ts-node').register({ project: 'tsconfig.tools.json' });
const { requireTestDatabaseUrl } = require('../test-database-url.ts');
process.env.DATABASE_URL = requireTestDatabaseUrl(process.env.TEST_DATABASE_URL);
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaService } = require('../../dist/database/prisma.service');
const { GameService } = require('../../dist/game/game.service');

function move(gameId, ply, playedById) {
  return {
    gameId,
    ply,
    moveNumber: Math.ceil(ply / 2),
    color: ply % 2 === 1 ? 'WHITE' : 'BLACK',
    playedById,
    san: 'e4',
    uci: 'e2e4',
    fenAfter: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    timeSpentMs: 25,
    timeRemainingMs: 599_000,
    createdAt: new Date(),
  };
}

test('real PostgreSQL: moves persist, retries are idempotent, poison rows are isolated', async (t) => {
  const prisma = new PrismaService();
  await prisma.$connect();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const userIds = [];
  const gameIds = [];
  t.after(async () => {
    try {
      // games first (cascades to game_moves), then the throw-away users
      await prisma.game.deleteMany({ where: { id: { in: gameIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } finally {
      await prisma.$disconnect();
    }
  });

  const makeUser = async (tag) => {
    const user = await prisma.user.create({
      data: {
        email: `mv_${tag}_${suffix}@example.test`,
        username: `mv_${tag}_${suffix}`.slice(0, 20),
        passwordHash: 'not-a-real-hash',
      },
    });
    userIds.push(user.id);
    return user.id;
  };
  const white = await makeUser('w');
  const black = await makeUser('b');
  const makeGame = async () => {
    const game = await prisma.game.create({
      data: { whiteId: white, blackId: black, result: 'IN_PROGRESS' },
    });
    gameIds.push(game.id);
    return game.id;
  };

  const service = new GameService(undefined, prisma);

  await t.test('persists a full game and removeGame waits for it', async () => {
    const gameId = await makeGame();
    service.createGame({ gameId, whitePlayerId: white, blackPlayerId: black });
    for (let ply = 1; ply <= 120; ply++) {
      service.enqueueMoveForPersistence(move(gameId, ply, ply % 2 ? white : black));
    }
    assert.equal(await service.removeGame(gameId), true);

    const rows = await prisma.gameMove.findMany({ where: { gameId }, orderBy: { ply: 'asc' } });
    assert.equal(rows.length, 120);
    assert.deepEqual(rows.map((r) => r.ply), Array.from({ length: 120 }, (_, i) => i + 1));
    assert.equal(rows[0].color, 'WHITE');
    assert.equal(rows[1].color, 'BLACK');
    assert.equal(rows[0].playedById, white);
    assert.equal(service.getPendingMovesCount(), 0);
  });

  await t.test('re-sending already stored plies is absorbed by UNIQUE(game_id, ply)', async () => {
    const gameId = await makeGame();
    service.enqueueMoveForPersistence(move(gameId, 1, white));
    await service.flushPendingMoves();
    service.enqueueMoveForPersistence(move(gameId, 1, white)); // duplicate
    service.enqueueMoveForPersistence(move(gameId, 2, black));
    await service.flushPendingMoves();

    assert.equal(await prisma.gameMove.count({ where: { gameId } }), 2);
    assert.equal(service.getDeadLetterMoves().filter((d) => d.record.gameId === gameId).length, 0);
  });

  await t.test('a ply for a game without a games row is dead-lettered, others still persist', async () => {
    const goodGame = await makeGame();
    const orphanGame = randomUUID(); // no games row -> FK violation (P2003)
    service.enqueueMoveForPersistence(move(goodGame, 1, white));
    service.enqueueMoveForPersistence(move(orphanGame, 1, white));
    service.enqueueMoveForPersistence(move(goodGame, 2, black));
    await service.flushPendingMoves();

    assert.equal(await prisma.gameMove.count({ where: { gameId: goodGame } }), 2);
    assert.equal(await prisma.gameMove.count({ where: { gameId: orphanGame } }), 0);
    const dead = service.getDeadLetterMoves().filter((d) => d.record.gameId === orphanGame);
    assert.equal(dead.length, 1);
    assert.match(dead[0].reason, /^P2003/);
    assert.equal(service.getPendingMovesCount(), 0);
  });

  await t.test('a value the schema rejects (VARCHAR(10) san) is dead-lettered, not retried forever', async () => {
    const gameId = await makeGame();
    service.enqueueMoveForPersistence({ ...move(gameId, 1, white), san: 'x'.repeat(40) });
    service.enqueueMoveForPersistence(move(gameId, 2, black));
    await service.flushPendingMoves();

    assert.equal(await prisma.gameMove.count({ where: { gameId } }), 1);
    assert.equal(service.getPendingMovesCount(), 0);
    assert.ok(service.getDeadLetterMoves().some((d) => d.record.gameId === gameId && d.record.ply === 1));
  });

  await t.test('a non-UUID playedById is rejected permanently (no endless retry)', async () => {
    const gameId = await makeGame();
    service.enqueueMoveForPersistence(move(gameId, 1, 'not-a-uuid'));
    await service.flushPendingMoves();
    assert.equal(service.getPendingMovesCount(), 0);
    assert.equal(await prisma.gameMove.count({ where: { gameId } }), 0);
  });
});
