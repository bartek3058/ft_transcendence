import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import {
  GlobalStatsDto,
  LeaderboardItemDto,
  PaginatedLeaderboardDto,
  PlayerRankingDto,
} from './dto/leaderboard-response.dto';
import { RANKED_USER_WHERE, USERNAME_REGEX } from '../../rating/ranked-users';
import { emptyRecord, FINISHED_RESULTS, loadPlayerRecords } from '../../rating/player-records';

@Injectable()
export class LeaderboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getLeaderboard(page = 1, limit = 20): Promise<PaginatedLeaderboardDto> {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(50, Math.max(1, limit));
    const offset = (safePage - 1) * safeLimit;

    const [total, users] = await Promise.all([
      this.prisma.user.count({ where: RANKED_USER_WHERE }),
      this.prisma.user.findMany({
        where: RANKED_USER_WHERE,
        orderBy: [{ rating: 'desc' }, { username: 'asc' }],
        skip: offset,
        take: safeLimit,
        select: { id: true, username: true, rating: true },
      }),
    ]);

    const records = await loadPlayerRecords(this.prisma, users.map((u) => u.id));

    const items: LeaderboardItemDto[] = users.map((u, i) => {
      const s = records.get(u.id) ?? emptyRecord();
      return {
        rank: offset + i + 1,
        userId: u.id,
        username: u.username,
        rating: u.rating,
        gamesPlayed: s.games,
        wins: s.wins,
        losses: s.losses,
        draws: s.draws,
        winRate: s.winRate,
      };
    });

    const totalPages = Math.ceil(total / safeLimit) || 1;

    return {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages,
      items,
    };
  }

  async getGlobalStats(): Promise<GlobalStatsDto> {
    const [totalPlayers, totalMatches, ratingAgg, topUser] = await Promise.all([
      this.prisma.user.count({ where: RANKED_USER_WHERE }),
      this.prisma.game.count({
        where: { result: { in: [...FINISHED_RESULTS] } },
      }),
      this.prisma.user.aggregate({
        where: RANKED_USER_WHERE,
        _avg: { rating: true },
        _max: { rating: true },
      }),
      this.prisma.user.findFirst({
        where: RANKED_USER_WHERE,
        orderBy: [{ rating: 'desc' }, { username: 'asc' }],
        select: { username: true, rating: true },
      }),
    ]);

    return {
      totalPlayers,
      totalMatches,
      averageRating: ratingAgg._avg.rating != null ? Math.round(ratingAgg._avg.rating) : 1200,
      highestRating: ratingAgg._max.rating ?? 1200,
      topPlayer: topUser ? { username: topUser.username, rating: topUser.rating } : null,
    };
  }

  async getPlayerRanking(username: string): Promise<PlayerRankingDto> {
    // Validate before I/O; preserve case to select the exact account.
    const normalized = typeof username === 'string' ? username.trim() : '';
    if (!USERNAME_REGEX.test(normalized)) {
      throw new BadRequestException({
        error: { code: 'INVALID_USERNAME', message: 'Username must match ^[A-Za-z0-9_]{3,20}$.' },
      });
    }

    const user = await this.prisma.user.findFirst({
      where: { username: normalized, ...RANKED_USER_WHERE },
      select: { id: true, username: true, rating: true },
    });

    // Fixed message: never echo caller input back.
    if (!user) {
      throw new NotFoundException({
        error: { code: 'PLAYER_NOT_FOUND', message: 'Player not found.' },
      });
    }

    const [higherCount, records] = await Promise.all([
      this.prisma.user.count({
        where: {
          ...RANKED_USER_WHERE,
          OR: [
            { rating: { gt: user.rating } },
            { rating: user.rating, username: { lt: user.username } },
          ],
        },
      }),
      loadPlayerRecords(this.prisma, [user.id]),
    ]);
    const record = records.get(user.id) ?? emptyRecord();

    return {
      rank: higherCount + 1,
      userId: user.id,
      username: user.username,
      rating: user.rating,
      gamesPlayed: record.games,
      wins: record.wins,
      losses: record.losses,
      draws: record.draws,
      winRate: record.winRate,
    };
  }
}
