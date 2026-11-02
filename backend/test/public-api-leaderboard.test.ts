import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LeaderboardService } from '../src/public-api/leaderboard/leaderboard.service';
import { LeaderboardController } from '../src/public-api/leaderboard/leaderboard.controller';
import { RatingService } from '../src/rating/rating.service';
import { RatingController } from '../src/rating/rating.controller';
import { NotFoundException } from '@nestjs/common';

interface MockUser {
  id: string;
  username: string;
  rating: number;
}

interface MockGame {
  id: string;
  whiteId: string;
  blackId: string;
  result: string;
}

function createMockPrisma(users: MockUser[] = [], games: MockGame[] = []) {
  const usersStore = [...users];
  const gamesStore = [...games];

  return {
    user: {
      count: async (args?: any) => {
        if (!args?.where) return usersStore.length;
        if (args.where.OR) {
          const condition1 = args.where.OR[0];
          const condition2 = args.where.OR[1];
          const targetRating = condition1.rating.gt;
          const targetUsername = condition2.username.lt;

          return usersStore.filter((u) => {
            if (u.rating > targetRating) return true;
            if (u.rating === targetRating && u.username < targetUsername) return true;
            return false;
          }).length;
        }
        return usersStore.length;
      },
      findMany: async ({ orderBy, skip = 0, take = 20 }: any) => {
        const sorted = [...usersStore].sort((a, b) => {
          if (b.rating !== a.rating) return b.rating - a.rating;
          return a.username.localeCompare(b.username);
        });
        return sorted.slice(skip, skip + take).map((u) => ({
          id: u.id,
          username: u.username,
          rating: u.rating,
        }));
      },
      findFirst: async (args?: any) => {
        if (args?.where?.username?.equals) {
          const target = args.where.username.equals.toLowerCase();
          const found = usersStore.find((u) => u.username.toLowerCase() === target);
          return found ? { id: found.id, username: found.username, rating: found.rating } : null;
        }
        if (args?.orderBy) {
          const sorted = [...usersStore].sort((a, b) => {
            if (b.rating !== a.rating) return b.rating - a.rating;
            return a.username.localeCompare(b.username);
          });
          const top = sorted[0];
          return top ? { id: top.id, username: top.username, rating: top.rating } : null;
        }
        return null;
      },
      aggregate: async (_args: any) => {
        if (usersStore.length === 0) {
          return { _avg: { rating: null }, _max: { rating: null } };
        }
        const total = usersStore.reduce((acc, u) => acc + u.rating, 0);
        const max = Math.max(...usersStore.map((u) => u.rating));
        return {
          _avg: { rating: total / usersStore.length },
          _max: { rating: max },
        };
      },
    },
    game: {
      count: async ({ where }: any) => {
        const results = where?.result?.in ?? [];
        return gamesStore.filter((g) => results.includes(g.result)).length;
      },
      findMany: async ({ where }: any) => {
        const results = where?.AND?.find((cond: any) => cond.result)?.result?.in ?? [];
        const orCond = where?.AND?.find((cond: any) => cond.OR)?.OR ?? [];
        const whiteIn = orCond.find((c: any) => c.whiteId)?.whiteId;
        const blackIn = orCond.find((c: any) => c.blackId)?.blackId;

        const userIds = new Set<string>();
        if (whiteIn?.in) whiteIn.in.forEach((id: string) => userIds.add(id));
        if (blackIn?.in) blackIn.in.forEach((id: string) => userIds.add(id));
        if (typeof whiteIn === 'string') userIds.add(whiteIn);
        if (typeof blackIn === 'string') userIds.add(blackIn);

        return gamesStore
          .filter((g) => {
            const matchesResult = results.length === 0 || results.includes(g.result);
            const matchesUser = userIds.size === 0 || userIds.has(g.whiteId) || userIds.has(g.blackId);
            return matchesResult && matchesUser;
          })
          .map((g) => ({
            whiteId: g.whiteId,
            blackId: g.blackId,
            result: g.result,
          }));
      },
    },
  };
}

describe('Public API Leaderboard & Stats Unit Tests', () => {
  const mockUsers: MockUser[] = [
    { id: 'u1', username: 'alice', rating: 1700 },
    { id: 'u2', username: 'bob', rating: 1850 },
    { id: 'u3', username: 'charlie', rating: 1600 },
    { id: 'u4', username: 'dave', rating: 1850 },
  ];

  const mockGames: MockGame[] = [
    { id: 'g1', whiteId: 'u2', blackId: 'u1', result: 'WHITE_WON' },
    { id: 'g2', whiteId: 'u1', blackId: 'u3', result: 'DRAW' },
    { id: 'g3', whiteId: 'u4', blackId: 'u2', result: 'BLACK_WON' },
    { id: 'g4', whiteId: 'u3', blackId: 'u4', result: 'BLACK_WON' },
    { id: 'g5', whiteId: 'u1', blackId: 'u4', result: 'IN_PROGRESS' }, // Unfinished, should not count
  ];

  describe('LeaderboardService.getLeaderboard', () => {
    it('returns sorted leaderboard with correct ranking and stats', async () => {
      const prisma = createMockPrisma(mockUsers, mockGames);
      const service = new LeaderboardService(prisma as any);

      const res = await service.getLeaderboard(1, 10);
      assert.equal(res.page, 1);
      assert.equal(res.limit, 10);
      assert.equal(res.total, 4);
      assert.equal(res.totalPages, 1);
      assert.equal(res.items.length, 4);

      // Rank order: bob (1850), dave (1850), alice (1700), charlie (1600)
      assert.equal(res.items[0].username, 'bob');
      assert.equal(res.items[0].rank, 1);
      assert.equal(res.items[0].rating, 1850);
      assert.equal(res.items[0].gamesPlayed, 2);
      assert.equal(res.items[0].wins, 2); // won g1, won g3
      assert.equal(res.items[0].winRate, 100);

      assert.equal(res.items[1].username, 'dave');
      assert.equal(res.items[1].rank, 2);
      assert.equal(res.items[1].rating, 1850);
      assert.equal(res.items[1].gamesPlayed, 2);
      assert.equal(res.items[1].wins, 1); // lost g3, won g4
      assert.equal(res.items[1].losses, 1);
      assert.equal(res.items[1].winRate, 50);

      assert.equal(res.items[2].username, 'alice');
      assert.equal(res.items[2].rank, 3);
      assert.equal(res.items[2].rating, 1700);
      assert.equal(res.items[2].gamesPlayed, 2); // lost g1, drew g2 (g5 is in progress)
      assert.equal(res.items[2].draws, 1);
      assert.equal(res.items[2].losses, 1);
      assert.equal(res.items[2].winRate, 0);

      assert.equal(res.items[3].username, 'charlie');
      assert.equal(res.items[3].rank, 4);
      assert.equal(res.items[3].rating, 1600);
    });

    it('clamps pagination arguments (page min 1, limit 1..50)', async () => {
      const prisma = createMockPrisma(mockUsers, mockGames);
      const service = new LeaderboardService(prisma as any);

      const resUnder = await service.getLeaderboard(-5, -10);
      assert.equal(resUnder.page, 1);
      assert.equal(resUnder.limit, 1);

      const resOver = await service.getLeaderboard(1, 100);
      assert.equal(resOver.limit, 50);
    });

    it('handles empty database gracefully', async () => {
      const prisma = createMockPrisma([], []);
      const service = new LeaderboardService(prisma as any);

      const res = await service.getLeaderboard(1, 20);
      assert.equal(res.total, 0);
      assert.equal(res.totalPages, 1);
      assert.equal(res.items.length, 0);
    });
  });

  describe('LeaderboardService.getGlobalStats', () => {
    it('aggregates total players, completed matches, average and top player', async () => {
      const prisma = createMockPrisma(mockUsers, mockGames);
      const service = new LeaderboardService(prisma as any);

      const stats = await service.getGlobalStats();
      assert.equal(stats.totalPlayers, 4);
      assert.equal(stats.totalMatches, 4); // 4 completed rated matches, excluding g5
      assert.equal(stats.highestRating, 1850);
      assert.equal(stats.averageRating, Math.round((1700 + 1850 + 1600 + 1850) / 4)); // 1750
      assert.ok(stats.topPlayer);
      assert.equal(stats.topPlayer.username, 'bob');
      assert.equal(stats.topPlayer.rating, 1850);
    });

    it('returns default fallback when no players exist', async () => {
      const prisma = createMockPrisma([], []);
      const service = new LeaderboardService(prisma as any);

      const stats = await service.getGlobalStats();
      assert.equal(stats.totalPlayers, 0);
      assert.equal(stats.totalMatches, 0);
      assert.equal(stats.averageRating, 1200);
      assert.equal(stats.highestRating, 1200);
      assert.equal(stats.topPlayer, null);
    });
  });

  describe('LeaderboardService.getPlayerRanking', () => {
    it('computes individual rank, win/loss stats and win rate', async () => {
      const prisma = createMockPrisma(mockUsers, mockGames);
      const service = new LeaderboardService(prisma as any);

      const ranking = await service.getPlayerRanking('dave');
      assert.equal(ranking.username, 'dave');
      assert.equal(ranking.rank, 2);
      assert.equal(ranking.rating, 1850);
      assert.equal(ranking.gamesPlayed, 2);
      assert.equal(ranking.wins, 1);
      assert.equal(ranking.losses, 1);
      assert.equal(ranking.draws, 0);
      assert.equal(ranking.winRate, 50);
    });

    it('handles case-insensitive username lookup', async () => {
      const prisma = createMockPrisma(mockUsers, mockGames);
      const service = new LeaderboardService(prisma as any);

      const ranking = await service.getPlayerRanking('BOB');
      assert.equal(ranking.username, 'bob');
      assert.equal(ranking.rank, 1);
      assert.equal(ranking.winRate, 100);
    });

    it('throws NotFoundException for non-existent player', async () => {
      const prisma = createMockPrisma(mockUsers, mockGames);
      const service = new LeaderboardService(prisma as any);

      await assert.rejects(
        () => service.getPlayerRanking('unknown_grandmaster'),
        (err: any) => err instanceof NotFoundException,
      );
    });

    it('throws NotFoundException for empty or whitespace username', async () => {
      const prisma = createMockPrisma(mockUsers, mockGames);
      const service = new LeaderboardService(prisma as any);

      await assert.rejects(
        () => service.getPlayerRanking('   '),
        (err: any) => err instanceof NotFoundException,
      );
    });
  });

  describe('LeaderboardController', () => {
    it('delegates to service correctly', async () => {
      const prisma = createMockPrisma(mockUsers, mockGames);
      const service = new LeaderboardService(prisma as any);
      const controller = new LeaderboardController(service);

      const leaderboard = await controller.getLeaderboard({ page: 1, limit: 10 });
      assert.equal(leaderboard.items.length, 4);

      const stats = await controller.getStats();
      assert.equal(stats.totalPlayers, 4);

      const player = await controller.getPlayerRanking('alice');
      assert.equal(player.rank, 3);
    });
  });

  describe('Web Leaderboard (RatingService & RatingController)', () => {
    it('RatingService.getLeaderboard returns formatted entries and total', async () => {
      const prisma = createMockPrisma(mockUsers, mockGames);
      const ratingService = new RatingService(prisma as any);

      const res = await ratingService.getLeaderboard(10, 0);
      assert.equal(res.total, 4);
      assert.equal(res.entries.length, 4);
      assert.equal(res.entries[0].username, 'bob');
      assert.equal(res.entries[0].rank, 1);
      assert.equal(res.entries[0].rating, 1850);
      assert.equal(res.entries[1].username, 'dave');
      assert.equal(res.entries[1].rank, 2);
    });

    it('RatingController delegates to RatingService with query params', async () => {
      const prisma = createMockPrisma(mockUsers, mockGames);
      const ratingService = new RatingService(prisma as any);
      const controller = new RatingController(ratingService);

      const res = await controller.getLeaderboard(50, 0);
      assert.equal(res.total, 4);
      assert.equal(res.entries.length, 4);
    });
  });
});
