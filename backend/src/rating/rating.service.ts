import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { computeElo, EloOutcome, EloResult } from './elo';

const RATED_RESULTS: readonly EloResult[] = ['WHITE_WON', 'BLACK_WON', 'DRAW'];

@Injectable()
export class RatingService {
  private readonly logger = new Logger(RatingService.name);

  constructor(private readonly prisma: PrismaService) {}

  preview(whiteRating: number, blackRating: number, result: EloResult): EloOutcome {
    return computeElo({ whiteRating, blackRating, result });
  }

  async getLeaderboard(limit = 20, offset = 0) {
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
    const safeOffset = Math.max(0, Number(offset) || 0);

    const [total, users] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.findMany({
        orderBy: [{ rating: 'desc' }, { username: 'asc' }],
        skip: safeOffset,
        take: safeLimit,
        select: { id: true, username: true, rating: true },
      }),
    ]);

    const entries = users.map((u, i) => ({
      rank: safeOffset + i + 1,
      id: u.id,
      username: u.username,
      rating: u.rating,
    }));

    return { total, entries };
  }

  
  async applyGameResult(gameId: string): Promise<EloOutcome | null> {
    const game = await this.prisma.game.findUnique({ where: { id: gameId } });

    if (!game) {
      this.logger.warn(`applyGameResult: game ${gameId} not found`);
      return null;
    }
    if (!RATED_RESULTS.includes(game.result as EloResult)) {
      this.logger.debug(`applyGameResult: game ${gameId} result "${game.result}" is not rated`);
      return null;
    }
    if (game.whiteId == null || game.blackId == null) {
      this.logger.debug(`applyGameResult: game ${gameId} has a missing player, skipping rating`);
      return null;
    }
    if (game.whiteRatingChange != null || game.blackRatingChange != null) {
      this.logger.debug(`applyGameResult: game ${gameId} already rated, skipping`);
      return null;
    }

    const whiteId = game.whiteId;
    const blackId = game.blackId;

    return this.prisma.$transaction(async (tx) => {
      const [white, black] = await Promise.all([
        tx.user.findUnique({ where: { id: whiteId } }),
        tx.user.findUnique({ where: { id: blackId } }),
      ]);
      if (!white || !black) {
        this.logger.warn(`applyGameResult: player row missing for game ${gameId}`);
        return null;
      }

      const outcome = computeElo({
        whiteRating: white.rating,
        blackRating: black.rating,
        result: game.result as EloResult,
      });

      await Promise.all([
        tx.user.update({ where: { id: whiteId }, data: { rating: outcome.whiteRating } }),
        tx.user.update({ where: { id: blackId }, data: { rating: outcome.blackRating } }),
        tx.game.update({
          where: { id: gameId },
          data: {
            whiteRating: white.rating,
            blackRating: black.rating,
            whiteRatingChange: outcome.whiteRatingChange,
            blackRatingChange: outcome.blackRatingChange,
          },
        }),
      ]);

      this.logger.log(
        `Rated game ${gameId}: white ${white.rating}->${outcome.whiteRating} (${fmt(outcome.whiteRatingChange)}), ` +
          `black ${black.rating}->${outcome.blackRating} (${fmt(outcome.blackRatingChange)})`,
      );

      return outcome;
    });
  }
}

function fmt(delta: number): string {
  return delta >= 0 ? `+${delta}` : `${delta}`;
}
