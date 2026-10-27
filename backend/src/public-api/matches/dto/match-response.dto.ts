import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PlayerSummaryDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  username: string;

  @ApiPropertyOptional()
  rating?: number;
}

export class MatchSummaryDto {
  @ApiProperty()
  id: string;

  @ApiPropertyOptional({ type: () => PlayerSummaryDto })
  whitePlayer: PlayerSummaryDto | null;

  @ApiPropertyOptional({ type: () => PlayerSummaryDto })
  blackPlayer: PlayerSummaryDto | null;

  @ApiProperty({ example: 'WHITE_WON' })
  result: string;

  @ApiPropertyOptional({ example: 'CHECKMATE' })
  endReason: string | null;

  @ApiPropertyOptional({ example: '10+0' })
  timeControl: string | null;

  @ApiPropertyOptional({ example: 16 })
  whiteRatingChange: number | null;

  @ApiPropertyOptional({ example: -16 })
  blackRatingChange: number | null;

  @ApiProperty()
  gameStart: Date;

  @ApiPropertyOptional()
  gameEnd: Date | null;
}

export class PaginatedMatchesDto {
  @ApiProperty({ type: [MatchSummaryDto] })
  items: MatchSummaryDto[];

  @ApiProperty({ example: 42 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 10 })
  limit: number;

  @ApiProperty({ example: 5 })
  totalPages: number;
}

export class MatchMoveDto {
  @ApiProperty({ example: 1 })
  ply: number;

  @ApiProperty({ example: 1 })
  moveNumber: number;

  @ApiProperty({ example: 'WHITE' })
  color: string;

  @ApiProperty({ example: 'e4' })
  san: string;

  @ApiProperty({ example: 'e2e4' })
  uci: string;

  @ApiProperty({ example: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1' })
  fenAfter: string;

  @ApiPropertyOptional({ example: 1200 })
  timeSpentMs: number | null;

  @ApiPropertyOptional({ example: 598800 })
  timeRemainingMs: number | null;
}

export class MatchDetailDto extends MatchSummaryDto {
  @ApiPropertyOptional({ example: '1. e4 e5 2. Nf3 Nc6 ...' })
  pgn: string | null;

  @ApiProperty({ type: [MatchMoveDto] })
  moves: MatchMoveDto[];
}
