import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { computeElo, EloOutcome, EloResult } from './elo';
import { RANKED_USER_WHERE } from './ranked-users';
import { LeaderboardEntry } from './leaderboard.types';
import { AI_BOT_ROLE } from '../ai/ai.constants';

const RATED_RESULTS: readonly EloResult[] = ['WHITE_WON', 'BLACK_WON', 'DRAW'];

@Injectable()
export class RatingService {
  private readonly logger = new Logger(RatingService.name);

  constructor(private readonly prisma: PrismaService) {}

  preview(whiteRating: number, blackRating: number, result: EloResult): EloOutcome {
    return computeElo({ whiteRating, blackRating, result });
  }

  async getLeaderboard(limit = 20, offset = 0) {
    // the DTO already checks this, clamp anyway
    const safeLimit = Math.min(100, Math.max(1, limit));
    const safeOffset = Math.min(10000, Math.max(0, offset));

    const [total, users] = await Promise.all([
      this.prisma.user.count({ where: RANKED_USER_WHERE }),
      this.prisma.user.findMany({
        where: RANKED_USER_WHERE,
        orderBy: [{ rating: 'desc' }, { username: 'asc' }],
        skip: safeOffset,
        take: safeLimit,
        select: { id: true, username: true, displayName: true, rating: true },
      }),
    ]);

    const entries = users.map((u, i) => ({
      rank: safeOffset + i + 1,
      id: u.id,
      username: u.username,
      displayName: u.displayName,
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

      // Games against the AI bot are never rated.
      if (white.role === AI_BOT_ROLE || black.role === AI_BOT_ROLE) {
        this.logger.debug(`applyGameResult: game ${gameId} is vs the AI bot, not rated`);
        return null;
      }

      const outcome = computeElo({
        whiteRating: white.rating,
        blackRating: black.rating,
        result: game.result as EloResult,
      });

      /* Claim the game atomically: only the call that flips the rating columns
      from null wins. Under READ COMMITTED a second concurrent call blocks on
      this row until we commit, then re-checks the WHERE, matches nothing and
      gets count 0 - so it bails out below without touching player ratings*/
      const claimed = await tx.game.updateMany({
        where: { id: gameId, whiteRatingChange: null, blackRatingChange: null },
        data: {
          whiteRating: white.rating,
          blackRating: black.rating,
          whiteRatingChange: outcome.whiteRatingChange,
          blackRatingChange: outcome.blackRatingChange,
        },
      });
      if (claimed.count === 0) {
        this.logger.debug(`applyGameResult: game ${gameId} claimed by a concurrent call, skipping`);
        return null;
      }

      await Promise.all([
        tx.user.update({ where: { id: whiteId }, data: { rating: outcome.whiteRating } }),
        tx.user.update({ where: { id: blackId }, data: { rating: outcome.blackRating } }),
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
