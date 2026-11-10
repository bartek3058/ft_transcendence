import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { RANKED_USER_WHERE } from "../rating/ranked-users";
import {
  emptyRecord,
  FINISHED_RESULTS,
  loadPlayerRecords,
} from "../rating/player-records";
import {
  RATING_HISTORY_DEFAULT_LIMIT,
  RATING_HISTORY_MAX_LIMIT,
} from "./dto/rating-history-query.dto";

const RECENT_GAMES = 8;

type HistoryGameRow = {
  id: string;
  whiteId: string | null;
  result: string;
  timeControl: string | null;
  whiteRatingChange: number | null;
  blackRatingChange: number | null;
  gameStart: Date;
  gameEnd: Date | null;
  whitePlayer: { username: string } | null;
  blackPlayer: { username: string } | null;
};

// Only the frozen snapshot on the game row (rating before + change), never users.rating.
const RATING_HISTORY_SELECT = {
  id: true,
  whiteId: true,
  result: true,
  whiteRating: true,
  blackRating: true,
  whiteRatingChange: true,
  blackRatingChange: true,
  gameStart: true,
  gameEnd: true,
  whitePlayer: { select: { username: true } },
  blackPlayer: { select: { username: true } },
} as const;

const HISTORY_SELECT = {
  id: true,
  whiteId: true,
  result: true,
  timeControl: true,
  whiteRatingChange: true,
  blackRatingChange: true,
  gameStart: true,
  gameEnd: true,
  whitePlayer: { select: { username: true } },
  blackPlayer: { select: { username: true } },
} as const;

@Injectable()
export class ProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async getMyProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        username: true,
        rating: true,
        status: true,
        createdAt: true,
      },
    });
    if (!user)
      throw new NotFoundException({
        error: { code: "USER_NOT_FOUND", message: "User not found." },
      });

    const [games, records, higherRankCount] = await Promise.all([
      this.prisma.game.findMany({
        where: this.finishedGamesOf(userId),
        select: HISTORY_SELECT,
        orderBy: [{ gameEnd: "desc" }, { id: "desc" }],
        take: RECENT_GAMES,
      }),
      loadPlayerRecords(this.prisma, [userId]),
      this.prisma.user.count({
        where: {
          ...RANKED_USER_WHERE,
          OR: [
            { rating: { gt: user.rating } },
            { rating: user.rating, username: { lt: user.username } },
          ],
        },
      }),
    ]);
    const record = records.get(userId) ?? emptyRecord();
    const rank = higherRankCount + 1;

    return {
      user: { ...user, rank },
      stats: {
        games: record.games,
        wins: record.wins,
        draws: record.draws,
        losses: record.losses,
        winRate: record.winRate,
        rank,
      },
      recentGames: games.map((game) => this.toHistoryItem(game, userId)),
    };
  }

  // full paginated history of the session, newest first
  async getMyGames(userId: string, page = 1, limit = 20) {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(50, Math.max(1, limit));
    const where = this.finishedGamesOf(userId);

    const [total, games] = await Promise.all([
      this.prisma.game.count({ where }),
      this.prisma.game.findMany({
        where,
        select: HISTORY_SELECT,
        orderBy: [{ gameEnd: "desc" }, { id: "desc" }],
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
    ]);

    return {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.ceil(total / safeLimit) || 1,
      items: games.map((game) => this.toHistoryItem(game, userId)),
    };
  }

  // ELO progression for a chart: the latest `limit` rated games, oldest first.
  // AI and aborted games are skipped, they have no rating change.
  async getMyRatingHistory(userId: string, limit = RATING_HISTORY_DEFAULT_LIMIT) {
    const safeLimit = Math.min(RATING_HISTORY_MAX_LIMIT, Math.max(1, limit));
    const where = {
      result: { in: [...FINISHED_RESULTS] },
      OR: [
        { whiteId: userId, whiteRating: { not: null }, whiteRatingChange: { not: null } },
        { blackId: userId, blackRating: { not: null }, blackRatingChange: { not: null } },
      ],
    };

    const [user, total, games] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { rating: true } }),
      this.prisma.game.count({ where }),
      this.prisma.game.findMany({
        where,
        select: RATING_HISTORY_SELECT,
        orderBy: [{ gameEnd: "desc" }, { id: "desc" }],
        take: safeLimit,
      }),
    ]);
    if (!user)
      throw new NotFoundException({
        error: { code: "USER_NOT_FOUND", message: "User not found." },
      });

    const points = games.reverse().map((game) => {
      const isWhite = game.whiteId === userId;
      const before = (isWhite ? game.whiteRating : game.blackRating)!;
      const change = (isWhite ? game.whiteRatingChange : game.blackRatingChange)!;
      return {
        gameId: game.id,
        playedAt: game.gameEnd ?? game.gameStart,
        ratingBefore: before,
        ratingAfter: before + change,
        change,
        outcome: this.outcomeFor(game.result, isWhite),
        opponent: isWhite
          ? (game.blackPlayer?.username ?? "Unknown player")
          : (game.whitePlayer?.username ?? "Unknown player"),
      };
    });

    return { currentRating: user.rating, total, limit: safeLimit, points };
  }

  private outcomeFor(result: string, isWhite: boolean) {
    if (result === "DRAW") return "DRAW";
    const won = (result === "WHITE_WON") === isWhite;
    return won ? "WIN" : "LOSS";
  }

  private finishedGamesOf(userId: string) {
    return {
      AND: [
        { OR: [{ whiteId: userId }, { blackId: userId }] },
        { result: { in: [...FINISHED_RESULTS] } },
      ],
    };
  }

  private toHistoryItem(game: HistoryGameRow, userId: string) {
    const isWhite = game.whiteId === userId;
    const won =
      (game.result === "WHITE_WON" && isWhite) ||
      (game.result === "BLACK_WON" && !isWhite);
    const outcome = game.result === "DRAW" ? "DRAW" : won ? "WIN" : "LOSS";
    return {
      id: game.id,
      opponent: isWhite
        ? (game.blackPlayer?.username ?? "Unknown player")
        : (game.whitePlayer?.username ?? "Unknown player"),
      color: isWhite ? "WHITE" : "BLACK",
      outcome,
      result: game.result,
      timeControl: game.timeControl,
      ratingChange: isWhite ? game.whiteRatingChange : game.blackRatingChange,
      playedAt: game.gameEnd ?? game.gameStart,
    };
  }
}
