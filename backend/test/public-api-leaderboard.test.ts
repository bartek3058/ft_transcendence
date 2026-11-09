import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { BadRequestException, ExecutionContext, HttpException, NotFoundException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { LeaderboardService } from '../src/public-api/leaderboard/leaderboard.service';
import { LeaderboardController } from '../src/public-api/leaderboard/leaderboard.controller';
import { PublicLeaderboardQueryDto } from '../src/public-api/leaderboard/dto/leaderboard-query.dto';
import { RatingService } from '../src/rating/rating.service';
import { RatingController } from '../src/rating/rating.controller';
import { WebLeaderboardQueryDto } from '../src/rating/dto/web-leaderboard-query.dto';
import { WebLeaderboardGuard } from '../src/rating/web-leaderboard.guard';
import { ApiKeyRateLimiter } from '../src/public-api/common/api-key-rate-limiter';
import { AuthValidationPipe } from '../src/auth/validation/auth-validation.pipe';
import { ProfileService } from '../src/profile/profile.service';
import { HistoryQueryDto } from '../src/profile/dto/history-query.dto';

/*
 * Unit tests with an in-memory Prisma double. They prove service logic only;
 * SQL, collation and index behaviour are covered by
 * test/integration/leaderboard-postgres.test.ts (run against a real *_test DB).
 */

interface MockUser {
  id: string;
  username: string;
  rating: number;
  role: 'user' | 'admin' | 'bot';
}

interface MockGame {
  id: string;
  whiteId: string | null;
  blackId: string | null;
  result: string;
  gameEnd?: Date;
}

const FINISHED = ['WHITE_WON', 'BLACK_WON', 'DRAW'];

/** Byte-order comparison, matching the users.username COLLATE "C" column. */
const byteCompare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function createMockPrisma(users: MockUser[] = [], games: MockGame[] = []) {
  const ranked = (where: any) =>
    users.filter((u) => {
      if (where?.role?.notIn) return !where.role.notIn.includes(u.role);
      if (where?.role?.not) return u.role !== where.role.not;
      return true;
    });

  const sorted = (list: MockUser[]) =>
    [...list].sort((a, b) => b.rating - a.rating || byteCompare(a.username, b.username));

  const project = (u: MockUser) => ({ id: u.id, username: u.username, rating: u.rating });

  return {
    // stands in for SELECT id FROM users WHERE lower(username) = lower($1)
    $queryRaw: async (_sql: TemplateStringsArray, name: string) =>
      users.filter((u) => u.username.toLowerCase() === name.toLowerCase()).map((u) => ({ id: u.id })),
    user: {
      count: async (args?: any) => {
        const pool = ranked(args?.where);
        if (!args?.where?.OR) return pool.length;
        const target = args.where.OR[0].rating.gt;
        const name = args.where.OR[1].username.lt;
        return pool.filter((u) => u.rating > target || (u.rating === target && u.username < name)).length;
      },
      findMany: async ({ where, skip = 0, take = 20 }: any) =>
        sorted(ranked(where)).slice(skip, skip + take).map(project),
      findFirst: async ({ where, orderBy }: any = {}) => {
        const pool = ranked(where);
        if (typeof where?.id === 'string') {
          const found = pool.find((u) => u.id === where.id);
          return found ? project(found) : null;
        }
        if (typeof where?.username === 'string') {
          const found = pool.find((u) => u.username === where.username);
          return found ? project(found) : null;
        }
        if (orderBy) {
          const top = sorted(pool)[0];
          return top ? project(top) : null;
        }
        return null;
      },
      findUnique: async ({ where }: any) => {
        const found = users.find((u) => u.id === where.id);
        return found
          ? { ...project(found), email: `${found.username}@example.test`, status: 'offline', createdAt: new Date(0) }
          : null;
      },
      aggregate: async ({ where }: any) => {
        const pool = ranked(where);
        if (pool.length === 0) return { _avg: { rating: null }, _max: { rating: null } };
        return {
          _avg: { rating: pool.reduce((acc, u) => acc + u.rating, 0) / pool.length },
          _max: { rating: Math.max(...pool.map((u) => u.rating)) },
        };
      },
    },
    game: {
      count: async ({ where }: any) => {
        if (where?.result?.in) return games.filter((g) => where.result.in.includes(g.result)).length;
        const userId = where?.AND?.[0]?.OR?.[0]?.whiteId;
        return games.filter((g) => FINISHED.includes(g.result) && (g.whiteId === userId || g.blackId === userId)).length;
      },
      groupBy: async ({ by, where }: any) => {
        const column: 'whiteId' | 'blackId' = by[0];
        const ids: string[] = where[column].in;
        const buckets = new Map<string, { id: string | null; result: string; n: number }>();
        for (const g of games) {
          const id = g[column];
          if (!id || !ids.includes(id) || !where.result.in.includes(g.result)) continue;
          const key = `${id}|${g.result}`;
          const bucket = buckets.get(key) ?? { id, result: g.result, n: 0 };
          bucket.n += 1;
          buckets.set(key, bucket);
        }
        return [...buckets.values()].map((b) => ({ [column]: b.id, result: b.result, _count: { _all: b.n } }));
      },
      findMany: async ({ where, skip = 0, take = 20 }: any) => {
        const userId = where?.AND?.[0]?.OR?.[0]?.whiteId;
        return games
          .filter((g) => FINISHED.includes(g.result) && (g.whiteId === userId || g.blackId === userId))
          .sort((a, b) => (b.gameEnd?.getTime() ?? 0) - (a.gameEnd?.getTime() ?? 0))
          .slice(skip, skip + take)
          .map((g) => ({
            id: g.id,
            whiteId: g.whiteId,
            result: g.result,
            timeControl: null,
            whiteRatingChange: null,
            blackRatingChange: null,
            gameStart: new Date(0),
            gameEnd: g.gameEnd ?? null,
            whitePlayer: users.find((u) => u.id === g.whiteId) ?? null,
            blackPlayer: users.find((u) => u.id === g.blackId) ?? null,
          }));
      },
    },
  };
}

const mockUsers: MockUser[] = [
  { id: 'u0', username: 'root_admin', rating: 2500, role: 'admin' },
  // Rated above everyone so any leak into a ranking or stat shows up.
  { id: 'u5', username: 'stockfish', rating: 2000, role: 'bot' },
  { id: 'u1', username: 'alice', rating: 1700, role: 'user' },
  { id: 'u2', username: 'bob', rating: 1850, role: 'user' },
  { id: 'u3', username: 'charlie', rating: 1600, role: 'user' },
  { id: 'u4', username: 'dave', rating: 1850, role: 'user' },
];

const mockGames: MockGame[] = [
  { id: 'g1', whiteId: 'u2', blackId: 'u1', result: 'WHITE_WON', gameEnd: new Date(1000) },
  { id: 'g2', whiteId: 'u1', blackId: 'u3', result: 'DRAW', gameEnd: new Date(2000) },
  { id: 'g3', whiteId: 'u4', blackId: 'u2', result: 'BLACK_WON', gameEnd: new Date(3000) },
  { id: 'g4', whiteId: 'u3', blackId: 'u4', result: 'BLACK_WON', gameEnd: new Date(4000) },
  { id: 'g5', whiteId: 'u1', blackId: 'u4', result: 'IN_PROGRESS' },
  { id: 'g6', whiteId: 'u1', blackId: 'u2', result: 'ABORTED' },
];

function service() {
  return new LeaderboardService(createMockPrisma(mockUsers, mockGames) as any);
}

function contextFor(ip: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ ip, socket: { remoteAddress: ip } }),
      getResponse: () => ({}),
      getNext: () => () => {},
    }),
  } as any;
}

async function validateQuery(metatype: any, value: Record<string, string>) {
  return new AuthValidationPipe().transform(value, { type: 'query', metatype, data: undefined });
}

describe('Public API Leaderboard & Stats (unit)', () => {
  describe('LeaderboardService.getLeaderboard', () => {
    it('returns ranked players with DB-aggregated records, excluding admins and the AI bot', async () => {
      const res = await service().getLeaderboard(1, 10);
      assert.equal(res.total, 4);
      assert.equal(res.totalPages, 1);
      assert.deepEqual(res.items.map((i) => i.username), ['bob', 'dave', 'alice', 'charlie']);
      assert.ok(!res.items.some((i) => i.username === 'root_admin' || i.username === 'stockfish'));

      const [bob, dave, alice, charlie] = res.items;
      assert.deepEqual([bob.rank, bob.gamesPlayed, bob.wins, bob.winRate], [1, 2, 2, 100]);
      assert.deepEqual([dave.rank, dave.wins, dave.losses, dave.winRate], [2, 1, 1, 50]);
      // IN_PROGRESS (g5) and ABORTED (g6) must not count.
      assert.deepEqual([alice.rank, alice.gamesPlayed, alice.draws, alice.losses], [3, 2, 1, 1]);
      assert.deepEqual([charlie.rank, charlie.gamesPlayed], [4, 2]);
    });

    it('clamps pagination arguments (page >= 1, limit 1..50)', async () => {
      const under = await service().getLeaderboard(-5, -10);
      assert.equal(under.page, 1);
      assert.equal(under.limit, 1);
      const over = await service().getLeaderboard(1, 100);
      assert.equal(over.limit, 50);
    });

    it('handles an empty database', async () => {
      const res = await new LeaderboardService(createMockPrisma() as any).getLeaderboard(1, 20);
      assert.deepEqual([res.total, res.totalPages, res.items.length], [0, 1, 0]);
    });
  });

  describe('LeaderboardService.getGlobalStats', () => {
    it('aggregates players and matches without admin and AI bot accounts', async () => {
      const stats = await service().getGlobalStats();
      assert.equal(stats.totalPlayers, 4);
      assert.equal(stats.totalMatches, 4);
      assert.equal(stats.highestRating, 1850);
      assert.equal(stats.averageRating, 1750);
      assert.equal(stats.topPlayer?.username, 'bob');
    });

    it('returns defaults when no players exist', async () => {
      const stats = await new LeaderboardService(createMockPrisma() as any).getGlobalStats();
      assert.deepEqual(
        [stats.totalPlayers, stats.totalMatches, stats.averageRating, stats.highestRating, stats.topPlayer],
        [0, 0, 1200, 1200, null],
      );
    });
  });

  describe('LeaderboardService.getPlayerRanking', () => {
    it('matches the rank shown in the paginated list', async () => {
      const list = await service().getLeaderboard(1, 50);
      for (const item of list.items) {
        const single = await service().getPlayerRanking(item.username);
        assert.equal(single.rank, item.rank, `rank mismatch for ${item.username}`);
        assert.equal(single.gamesPlayed, item.gamesPlayed);
      }
    });

    it('looks the name up case-insensitively', async () => {
      const ranking = await service().getPlayerRanking('  BOB ');
      assert.equal(ranking.username, 'bob');
      assert.equal(ranking.rank, 1);
    });

    it('rejects malformed usernames with 400 before any DB access', async () => {
      const throwingPrisma = new Proxy({}, { get: () => { throw new Error('DB must not be touched'); } });
      const strict = new LeaderboardService(throwingPrisma as any);
      for (const bad of ['', '   ', 'ab', 'a'.repeat(21), 'bob%', "bob' OR 1=1", '../etc']) {
        await assert.rejects(() => strict.getPlayerRanking(bad), (err: any) => {
          assert.ok(err instanceof BadRequestException, `expected 400 for ${JSON.stringify(bad)}`);
          assert.equal((err.getResponse() as any).error.code, 'INVALID_USERNAME');
          return true;
        });
      }
    });

    it('returns 404 with a fixed message for unknown players, admins and the AI bot', async () => {
      for (const name of ['unknown_gm', 'root_admin', 'stockfish']) {
        await assert.rejects(() => service().getPlayerRanking(name), (err: any) => {
          assert.ok(err instanceof NotFoundException);
          assert.equal((err.getResponse() as any).error.message, 'Player not found.');
          return true;
        });
      }
    });
  });

  describe('LeaderboardController routing', () => {
    it('serves the player lookup under players/:username so "stats" is a valid username', () => {
      assert.equal(Reflect.getMetadata(PATH_METADATA, LeaderboardController.prototype.getPlayerRanking), 'players/:username');
      assert.equal(Reflect.getMetadata(PATH_METADATA, LeaderboardController.prototype.getStats), 'stats');
    });

    it('delegates to the service', async () => {
      const controller = new LeaderboardController(service());
      assert.equal((await controller.getLeaderboard({ page: 1, limit: 10 })).items.length, 4);
      assert.equal((await controller.getStats()).totalPlayers, 4);
      assert.equal((await controller.getPlayerRanking('alice')).rank, 3);
    });
  });

  describe('Query validation through the global AuthValidationPipe', () => {
    const rejects = async (metatype: any, value: Record<string, string>) =>
      assert.rejects(() => validateQuery(metatype, value), BadRequestException);

    it('public leaderboard: rejects limit > 50, page < 1, non-integers and unknown fields', async () => {
      await rejects(PublicLeaderboardQueryDto, { limit: '51' });
      await rejects(PublicLeaderboardQueryDto, { page: '0' });
      await rejects(PublicLeaderboardQueryDto, { page: 'abc' });
      await rejects(PublicLeaderboardQueryDto, { limit: '1.5' });
      await rejects(PublicLeaderboardQueryDto, { sort: 'rating' });
      const ok = await validateQuery(PublicLeaderboardQueryDto, { page: '2', limit: '50' });
      assert.deepEqual([ok.page, ok.limit], [2, 50]);
    });

    it('web leaderboard: rejects Infinity, huge offsets and limit > 100', async () => {
      await rejects(WebLeaderboardQueryDto, { offset: 'Infinity' });
      await rejects(WebLeaderboardQueryDto, { offset: '1e30' });
      await rejects(WebLeaderboardQueryDto, { offset: '10001' });
      await rejects(WebLeaderboardQueryDto, { limit: '101' });
      const ok = await validateQuery(WebLeaderboardQueryDto, {});
      assert.deepEqual([ok.limit, ok.offset], [20, 0]);
    });

    it('match history: rejects limit > 50 and page > 1000', async () => {
      await rejects(HistoryQueryDto, { limit: '51' });
      await rejects(HistoryQueryDto, { page: '1001' });
    });
  });

  describe('Web leaderboard (RatingService, RatingController, WebLeaderboardGuard)', () => {
    it('RatingService excludes admins and the AI bot and ranks by rating then username', async () => {
      const res = await new RatingService(createMockPrisma(mockUsers, mockGames) as any).getLeaderboard(10, 0);
      assert.equal(res.total, 4);
      assert.deepEqual(res.entries.map((e) => [e.rank, e.username]), [[1, 'bob'], [2, 'dave'], [3, 'alice'], [4, 'charlie']]);
    });

    it('RatingController passes the validated DTO through', async () => {
      const controller = new RatingController(new RatingService(createMockPrisma(mockUsers, mockGames) as any));
      const res = await controller.getLeaderboard({ limit: 2, offset: 1 });
      assert.deepEqual(res.entries.map((e) => e.rank), [2, 3]);
    });

    it('WebLeaderboardGuard allows 60 req/min per IP, then 429 with an isolated bucket per IP', () => {
      const guard = new WebLeaderboardGuard(new ApiKeyRateLimiter());
      for (let i = 0; i < 60; i++) assert.equal(guard.canActivate(contextFor('10.0.0.1')), true);
      assert.throws(() => guard.canActivate(contextFor('10.0.0.1')), (err: any) => {
        assert.ok(err instanceof HttpException);
        assert.equal(err.getStatus(), 429);
        return true;
      });
      assert.equal(guard.canActivate(contextFor('10.0.0.2')), true);
    });
  });

  describe('ProfileService history', () => {
    it('getMyProfile uses aggregated records and ranks without admins and the AI bot', async () => {
      const profile = await new ProfileService(createMockPrisma(mockUsers, mockGames) as any).getMyProfile('u4');
      assert.deepEqual([profile.stats.games, profile.stats.wins, profile.stats.losses, profile.stats.winRate], [2, 1, 1, 50]);
      assert.equal(profile.user.rank, 2);
    });

    it('getMyGames paginates newest first with dates and outcomes', async () => {
      const svc = new ProfileService(createMockPrisma(mockUsers, mockGames) as any);
      const first = await svc.getMyGames('u1', 1, 1);
      assert.deepEqual([first.total, first.totalPages], [2, 2]);
      assert.equal(first.items[0].id, 'g2');
      assert.equal(first.items[0].outcome, 'DRAW');
      assert.ok(first.items[0].playedAt instanceof Date);
      const second = await svc.getMyGames('u1', 2, 1);
      assert.equal(second.items[0].id, 'g1');
      assert.equal(second.items[0].outcome, 'LOSS');
      assert.equal(second.items[0].opponent, 'bob');
    });
  });
});
