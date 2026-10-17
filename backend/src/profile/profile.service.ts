import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";

const FINISHED_RESULTS = ["WHITE_WON", "BLACK_WON", "DRAW"] as const;

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

    const games = await this.prisma.game.findMany({
      where: {
        AND: [
          { OR: [{ whiteId: userId }, { blackId: userId }] },
          { result: { in: [...FINISHED_RESULTS] } },
        ],
      },
      include: {
        whitePlayer: { select: { id: true, username: true } },
        blackPlayer: { select: { id: true, username: true } },
      },
      orderBy: { gameEnd: "desc" },
      take: 8,
    });

    const totals = await this.prisma.game.findMany({
      where: {
        AND: [
          { OR: [{ whiteId: userId }, { blackId: userId }] },
          { result: { in: [...FINISHED_RESULTS] } },
        ],
      },
      select: { whiteId: true, blackId: true, result: true },
    });

    let wins = 0,
      draws = 0,
      losses = 0;
    for (const game of totals) {
      if (game.result === "DRAW") draws++;
      else if (
        (game.result === "WHITE_WON" && game.whiteId === userId) ||
        (game.result === "BLACK_WON" && game.blackId === userId)
      )
        wins++;
      else losses++;
    }

    return {
      user,
      stats: { games: totals.length, wins, draws, losses },
      recentGames: games.map((game) => {
        const isWhite = game.whiteId === userId;
        const won =
          (game.result === "WHITE_WON" && isWhite) ||
          (game.result === "BLACK_WON" && !isWhite);
        const outcome = game.result === "DRAW" ? "DRAW" : won ? "WIN" : "LOSS";
        return {
          id: game.id,
          opponent: isWhite
            ? (game.blackPlayer?.username ?? "Nieznany gracz")
            : (game.whitePlayer?.username ?? "Nieznany gracz"),
          color: isWhite ? "WHITE" : "BLACK",
          outcome,
          result: game.result,
          timeControl: game.timeControl,
          ratingChange: isWhite
            ? game.whiteRatingChange
            : game.blackRatingChange,
          playedAt: game.gameEnd ?? game.gameStart,
        };
      }),
    };
  }
}
