import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../src/database/prisma.service';
import { RatingService } from '../../src/rating/rating.service';
import { ProfileService } from '../../src/profile/profile.service';
import { requireTestDatabaseUrl } from '../test-database-url';

// ELO progression against real Postgres: games are rated by the real RatingService, so the
// snapshot columns hold exactly what production writes.
const prisma = new PrismaService({
  datasources: { db: { url: requireTestDatabaseUrl(process.env.TEST_DATABASE_URL) } },
});
const rating = new RatingService(prisma);
const profile = new ProfileService(prisma);
const userIds: string[] = [];
const gameIds: string[] = [];
const T0 = Date.UTC(2026, 10, 1);

async function createPlayer() {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const user = await prisma.user.create({ data: {
    email: `rh_${suffix}@example.test`, username: `rh_${suffix}`, passwordHash: '$argon2id$test-fixture',
  } });
  userIds.push(user.id);
  return user;
}

// a finished game ending `minute` minutes after T0, rated unless `rate` is false
async function play(whiteId: string, blackId: string, result: string, minute: number, rate = true) {
  const id = randomUUID();
  gameIds.push(id);
  await prisma.game.create({ data: {
    id, whiteId, blackId, result,
    gameStart: new Date(T0 + (minute - 1) * 60_000), gameEnd: new Date(T0 + minute * 60_000),
  } });
  if (rate) await rating.applyGameResult(id);
  return id;
}

describe('rating history against PostgreSQL', () => {
  let me: { id: string };
  let bob: { id: string };
  const rated: string[] = [];

  before(async () => {
    await prisma.$connect();
    me = await createPlayer();
    bob = await createPlayer();
    rated.push(await play(me.id, bob.id, 'WHITE_WON', 1)); // I win as white
    await play(me.id, bob.id, 'WHITE_WON', 2, false); // finished but never rated (like a game vs the AI)
    rated.push(await play(bob.id, me.id, 'WHITE_WON', 3)); // I lose as black
    await play(me.id, bob.id, 'ABORTED', 4); // aborted: no change
    rated.push(await play(bob.id, me.id, 'DRAW', 5)); // draw as black
    const live = randomUUID();
    gameIds.push(live);
    await prisma.game.create({ data: { id: live, whiteId: me.id, blackId: bob.id, result: 'IN_PROGRESS' } });
  });

  after(async () => {
    try {
      await prisma.game.deleteMany({ where: { id: { in: gameIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } finally {
      await prisma.$disconnect();
    }
  });

  it('lists only rated games, oldest first, and the chain ends at the current rating', async () => {
    const history = await profile.getMyRatingHistory(me.id);
    assert.deepEqual(history.points.map((p) => p.gameId), rated);
    assert.equal(history.total, 3);
    assert.deepEqual(history.points.map((p) => p.outcome), ['WIN', 'LOSS', 'DRAW']);

    assert.equal(history.points[0].ratingBefore, 1200);
    for (const [i, point] of history.points.entries()) {
      assert.equal(point.ratingAfter, point.ratingBefore + point.change);
      if (i > 0) assert.equal(point.ratingBefore, history.points[i - 1].ratingAfter);
    }
    const current = (await prisma.user.findUniqueOrThrow({ where: { id: me.id } })).rating;
    assert.equal(history.points.at(-1)!.ratingAfter, current);
    assert.equal(history.currentRating, current);
  });

  it('limit keeps the newest games, still oldest first', async () => {
    const history = await profile.getMyRatingHistory(me.id, 2);
    assert.deepEqual(history.points.map((p) => p.gameId), rated.slice(1));
    assert.deepEqual([history.total, history.limit], [3, 2]);
  });

  it('uses the frozen snapshot, not the live rating', async () => {
    await prisma.user.update({ where: { id: me.id }, data: { rating: 2500 } });
    const history = await profile.getMyRatingHistory(me.id);
    assert.equal(history.points[0].ratingBefore, 1200);
    assert.notEqual(history.points.at(-1)!.ratingAfter, 2500);
    assert.equal(history.currentRating, 2500);
  });

  it('a player with no rated games gets an empty list', async () => {
    const fresh = await createPlayer();
    const history = await profile.getMyRatingHistory(fresh.id);
    assert.deepEqual([history.points, history.total, history.currentRating], [[], 0, 1200]);
  });
});
