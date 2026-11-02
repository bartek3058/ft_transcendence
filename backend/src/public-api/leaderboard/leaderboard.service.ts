import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import {
  GlobalStatsDto,
  LeaderboardItemDto,
  PaginatedLeaderboardDto,
  PlayerRankingDto,
} from './dto/leaderboard-response.dto';

const RATED_RESULTS = ['WHITE_WON', 'BLACK_WON', 'DRAW'] as const;

@Injectable()
export class LeaderboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getLeaderboard(page = 1, limit = 20): Promise<PaginatedLeaderboardDto> {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(50, Math.max(1, limit));
    const offset = (safePage - 1) * safeLimit;

    const [total, users] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.findMany({
        orderBy: [{ rating: 'desc' }, { username: 'asc' }],
        skip: offset,
        take: safeLimit,
        select: { id: true, username: true, rating: true },
      }),
    ]);

    const userIds = users.map((u) => u.id);
    const matchTotals = userIds.length > 0
      ? await this.prisma.game.findMany({
          where: {
            AND: [
              { OR: [{ whiteId: { in: userIds } }, { blackId: { in: userIds } }] },
              { result: { in: [...RATED_RESULTS] } },
            ],
          },
          select: { whiteId: true, blackId: true, result: true },
        })
      : [];

    const statsMap = new Map<string, { wins: number; losses: number; draws: number; games: number }>();
    for (const id of userIds) {
      statsMap.set(id, { wins: 0, losses: 0, draws: 0, games: 0 });
    }

    for (const match of matchTotals) {
      if (match.whiteId && statsMap.has(match.whiteId)) {
        const s = statsMap.get(match.whiteId)!;
        s.games += 1;
        if (match.result === 'WHITE_WON') s.wins += 1;
        else if (match.result === 'DRAW') s.draws += 1;
        else s.losses += 1;
      }
      if (match.blackId && statsMap.has(match.blackId)) {
        const s = statsMap.get(match.blackId)!;
        s.games += 1;
        if (match.result === 'BLACK_WON') s.wins += 1;
        else if (match.result === 'DRAW') s.draws += 1;
        else s.losses += 1;
      }
    }

    const items: LeaderboardItemDto[] = users.map((u, i) => {
      const s = statsMap.get(u.id) ?? { wins: 0, losses: 0, draws: 0, games: 0 };
      const winRate = s.games > 0 ? Number(((s.wins / s.games) * 100).toFixed(1)) : 0;
      return {
        rank: offset + i + 1,
        userId: u.id,
        username: u.username,
        rating: u.rating,
        gamesPlayed: s.games,
        wins: s.wins,
        losses: s.losses,
        draws: s.draws,
        winRate,
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
      this.prisma.user.count(),
      this.prisma.game.count({
        where: { result: { in: [...RATED_RESULTS] } },
      }),
      this.prisma.user.aggregate({
        _avg: { rating: true },
        _max: { rating: true },
      }),
      this.prisma.user.findFirst({
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
    if (!username || !username.trim()) {
      throw new NotFoundException({
        error: { code: 'PLAYER_NOT_FOUND', message: 'Player not found.' },
      });
    }

    const user = await this.prisma.user.findFirst({
      where: {
        username: {
          equals: username.trim(),
          mode: 'insensitive',
        },
      },
      select: { id: true, username: true, rating: true },
    });

    if (!user) {
      throw new NotFoundException({
        error: { code: 'PLAYER_NOT_FOUND', message: `Player "${username}" not found.` },
      });
    }

    const [higherCount, matches] = await Promise.all([
      this.prisma.user.count({
        where: {
          OR: [
            { rating: { gt: user.rating } },
            { rating: user.rating, username: { lt: user.username } },
          ],
        },
      }),
      this.prisma.game.findMany({
        where: {
          AND: [
            { OR: [{ whiteId: user.id }, { blackId: user.id }] },
            { result: { in: [...RATED_RESULTS] } },
          ],
        },
        select: { whiteId: true, blackId: true, result: true },
      }),
    ]);

    let wins = 0;
    let losses = 0;
    let draws = 0;
    for (const m of matches) {
      const isWhite = m.whiteId === user.id;
      if (m.result === 'DRAW') {
        draws += 1;
      } else if (
        (m.result === 'WHITE_WON' && isWhite) ||
        (m.result === 'BLACK_WON' && !isWhite)
      ) {
        wins += 1;
      } else {
        losses += 1;
      }
    }

    const gamesPlayed = matches.length;
    const winRate = gamesPlayed > 0 ? Number(((wins / gamesPlayed) * 100).toFixed(1)) : 0;

    return {
      rank: higherCount + 1,
      userId: user.id,
      username: user.username,
      rating: user.rating,
      gamesPlayed,
      wins,
      losses,
      draws,
      winRate,
    };
  }
}
