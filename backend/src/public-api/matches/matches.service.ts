import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { MatchQueryDto, MatchResultFilter } from './dto/match-query.dto';
import { MatchDetailDto, PaginatedMatchesDto } from './dto/match-response.dto';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class MatchesService {
  constructor(private readonly prisma: PrismaService) {}

  async findMatches(query: MatchQueryDto): Promise<PaginatedMatchesDto> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(50, Math.max(1, query.limit ?? 10));
    const skip = (page - 1) * limit;

    const where: any = {};

    if (query.username) {
      const cleanUsername = query.username.trim();
      where.OR = [
        { whitePlayer: { username: { equals: cleanUsername, mode: 'insensitive' } } },
        { blackPlayer: { username: { equals: cleanUsername, mode: 'insensitive' } } },
      ];
    }

    if (query.result && query.result !== MatchResultFilter.ALL) {
      where.result = query.result;
    }

    const [total, games] = await Promise.all([
      this.prisma.game.count({ where }),
      this.prisma.game.findMany({
        where,
        select: {
          id: true,
          result: true,
          endReason: true,
          timeControl: true,
          whiteRatingChange: true,
          blackRatingChange: true,
          gameStart: true,
          gameEnd: true,
          whitePlayer: { select: { id: true, username: true, rating: true } },
          blackPlayer: { select: { id: true, username: true, rating: true } },
        },
        orderBy: { gameStart: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    return {
      items: games,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }

  async findMatchById(id: string): Promise<MatchDetailDto> {
    if (!id || !UUID_REGEX.test(id)) {
      throw new BadRequestException({
        error: { code: 'INVALID_MATCH_ID', message: 'Match ID must be a valid UUID.' },
      });
    }

    const game = await this.prisma.game.findUnique({
      where: { id },
      select: {
        id: true,
        result: true,
        endReason: true,
        timeControl: true,
        whiteRatingChange: true,
        blackRatingChange: true,
        pgn: true,
        gameStart: true,
        gameEnd: true,
        whitePlayer: { select: { id: true, username: true, rating: true } },
        blackPlayer: { select: { id: true, username: true, rating: true } },
        moves: {
          select: {
            ply: true,
            moveNumber: true,
            color: true,
            san: true,
            uci: true,
            fenAfter: true,
            timeSpentMs: true,
            timeRemainingMs: true,
          },
          orderBy: { ply: 'asc' },
        },
      },
    });

    if (!game) {
      throw new NotFoundException({
        error: { code: 'MATCH_NOT_FOUND', message: 'Match not found.' },
      });
    }

    return game;
  }
}
