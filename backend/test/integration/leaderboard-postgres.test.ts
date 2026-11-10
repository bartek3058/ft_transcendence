import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { resolveTestDatabaseUrl } from '../test-database-url';
import { LeaderboardService } from '../../src/public-api/leaderboard/leaderboard.service';
import { RatingService } from '../../src/rating/rating.service';
import { ProfileService } from '../../src/profile/profile.service';
import { AI_BOT_EMAIL, AI_BOT_ROLE, AI_BOT_USER_ID, AI_BOT_USERNAME } from '../../src/ai/ai.constants';

/*
Real-PostgreSQL checks for what the in-memory unit tests cannot prove:
COLLATE "C" tie ordering, GROUP BY aggregation,
the role filter (admins, AI bot) and the new indexes. Requires TEST_DATABASE_URL
(application role, database name ending in _test) with migrations applied.
*/

const prisma = new PrismaClient({
  datasources: { db: { url: resolveTestDatabaseUrl() } },
});
const leaderboard = new LeaderboardService(prisma as any);
const rating = new RatingService(prisma as any);
const profile = new ProfileService(prisma as any);

// Ratings far above real play so fixtures occupy the top of the shared test DB.
const TOP = 9000;
const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
const names = {
  tieUpper: `lb_${suffix}_a`, // byte order: '_a' < '_b'
  tieLower: `lb_${suffix}_b`,
  third: `lb_${suffix}_c`,
  admin: `lb_${suffix}_x`,
  bot: `lb_${suffix}_y`,
};
const ids: Record<keyof typeof names, string> = { tieUpper: '', tieLower: '', third: '', admin: '', bot: '' };
const gameIds: string[] = [];
let createdAiBot = false;

/*
Records exclude games by the bot's fixed id, so the game against the bot must use
the real account. Reuse the seeded row when present; otherwise create it and
remove it afterwards.
*/
async function ensureAiBot() {
  const existing = await prisma.user.findUnique({ where: { id: AI_BOT_USER_ID }, select: { id: true } });
  if (existing) return;
  await prisma.user.create({
    data: {
      id: AI_BOT_USER_ID,
      email: AI_BOT_EMAIL,
      username: AI_BOT_USERNAME,
      rating: 1500,
      role: AI_BOT_ROLE,
      passwordHash: '$argon2id$test-fixture-not-a-real-password',
    },
  });
  createdAiBot = true;
}

async function createUser(username: string, ratingValue: number, role: 'user' | 'admin' | 'bot') {
  const user = await prisma.user.create({
    data: {
      email: `${username}@example.test`,
      username,
      rating: ratingValue,
      role,
      passwordHash: '$argon2id$test-fixture-not-a-real-password',
    },
  });
  return user.id;
}

async function createGame(whiteId: string, blackId: string, result: string, minutesAgo: number) {
  const start = new Date(Date.now() - (minutesAgo + 10) * 60000);
  const game = await prisma.game.create({
    data: {
      whiteId,
      blackId,
      result,
      gameStart: start,
      gameEnd: result === 'IN_PROGRESS' ? null : new Date(Date.now() - minutesAgo * 60000),
    },
  });
  gameIds.push(game.id);
}

describe('Leaderboard against PostgreSQL', () => {
  before(async () => {
    await prisma.$connect();
    ids.tieUpper = await createUser(names.tieUpper, TOP, 'user');
    ids.tieLower = await createUser(names.tieLower, TOP, 'user');
    ids.third = await createUser(names.third, TOP - 1, 'user');
    ids.admin = await createUser(names.admin, TOP + 500, 'admin');
    ids.bot = await createUser(names.bot, TOP + 400, AI_BOT_ROLE);
    await ensureAiBot();

    await createGame(ids.tieUpper, ids.tieLower, 'WHITE_WON', 40);
    await createGame(ids.tieLower, ids.tieUpper, 'DRAW', 30);
    await createGame(ids.third, ids.tieUpper, 'BLACK_WON', 20);
    await createGame(ids.tieUpper, ids.third, 'IN_PROGRESS', 10);
    await createGame(ids.third, ids.tieLower, 'ABORTED', 5);
    // A finished game against the bot: kept in history, left out of the record.
    await createGame(AI_BOT_USER_ID, ids.third, 'WHITE_WON', 3);
  });

  after(async () => {
    try {
      if (gameIds.length) await prisma.game.deleteMany({ where: { id: { in: gameIds } } });
      await prisma.user.deleteMany({ where: { id: { in: Object.values(ids).filter(Boolean) } } });
      if (createdAiBot) await prisma.user.delete({ where: { id: AI_BOT_USER_ID } });
    } finally {
      await prisma.$disconnect();
    }
  });

  it('orders ties by username in byte order and keeps list and single-player ranks consistent', async () => {
    const page = await leaderboard.getLeaderboard(1, 50);
    const position = (name: string) => page.items.find((i) => i.username === name)?.rank;

    const upper = position(names.tieUpper);
    const lower = position(names.tieLower);
    const third = position(names.third);
    assert.ok(upper && lower && third, 'fixtures must be on page 1');
    assert.equal(lower, upper + 1);
    assert.equal(third, lower + 1);

    for (const name of [names.tieUpper, names.tieLower, names.third]) {
      assert.equal((await leaderboard.getPlayerRanking(name)).rank, position(name), `rank mismatch for ${name}`);
    }
  });

  it('aggregates records with GROUP BY, counting only finished games', async () => {
    const upper = await leaderboard.getPlayerRanking(names.tieUpper);
    assert.deepEqual([upper.gamesPlayed, upper.wins, upper.draws, upper.losses], [3, 2, 1, 0]);
    assert.equal(upper.winRate, 66.7);

    const lower = await leaderboard.getPlayerRanking(names.tieLower.toUpperCase());
    assert.deepEqual([lower.gamesPlayed, lower.wins, lower.draws, lower.losses], [2, 0, 1, 1]);

    const listed = (await leaderboard.getLeaderboard(1, 50)).items.find((i) => i.username === names.third);
    // The loss against the bot is not counted.
    assert.deepEqual([listed?.gamesPlayed, listed?.losses], [1, 1]);
  });

  it('excludes admin accounts from the list, stats, web leaderboard and lookup', async () => {
    const page = await leaderboard.getLeaderboard(1, 50);
    assert.ok(!page.items.some((i) => i.username === names.admin));

    const stats = await leaderboard.getGlobalStats();
    assert.ok(stats.highestRating < TOP + 500);
    assert.notEqual(stats.topPlayer?.username, names.admin);

    const web = await rating.getLeaderboard(100, 0);
    assert.ok(!web.entries.some((e) => e.username === names.admin));

    await assert.rejects(() => leaderboard.getPlayerRanking(names.admin), NotFoundException);
  });

  it('excludes the AI bot from the list, stats, web leaderboard, lookup and rank counts', async () => {
    const page = await leaderboard.getLeaderboard(1, 50);
    assert.ok(!page.items.some((i) => i.username === names.bot));

    const stats = await leaderboard.getGlobalStats();
    assert.ok(stats.highestRating < TOP + 400);
    assert.notEqual(stats.topPlayer?.username, names.bot);

    const web = await rating.getLeaderboard(100, 0);
    assert.ok(!web.entries.some((e) => e.username === names.bot));

    await assert.rejects(() => leaderboard.getPlayerRanking(names.bot), NotFoundException);

    // The bot is rated above the fixtures; counting it would push their rank down.
    const humansAbove = await prisma.user.count({
      where: { role: { notIn: ['admin', AI_BOT_ROLE] }, rating: { gt: TOP } },
    });
    assert.equal((await leaderboard.getPlayerRanking(names.tieUpper)).rank, humansAbove + 1);
    assert.equal((await profile.getMyProfile(ids.tieUpper)).user.rank, humansAbove + 1);
  });

  it('returns full paginated match history newest first', async () => {
    const first = await profile.getMyGames(ids.tieUpper, 1, 2);
    assert.equal(first.total, 3);
    assert.equal(first.totalPages, 2);
    assert.deepEqual(first.items.map((g) => g.outcome), ['WIN', 'DRAW']);
    const second = await profile.getMyGames(ids.tieUpper, 2, 2);
    assert.deepEqual(second.items.map((g) => [g.outcome, g.opponent]), [['WIN', names.tieLower]]);
  });

  it('has the leaderboard indexes from the migration', async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN ('users_rating_username_idx', 'games_white_id_result_idx', 'games_black_id_result_idx')`;
    assert.equal(rows.length, 3);
  });
});
