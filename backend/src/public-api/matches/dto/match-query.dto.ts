import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export enum MatchResultFilter {
  ALL = 'ALL',
  WHITE_WON = 'WHITE_WON',
  BLACK_WON = 'BLACK_WON',
  DRAW = 'DRAW',
  IN_PROGRESS = 'IN_PROGRESS',
}

export class MatchQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, description: 'Page number' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 50, description: 'Items per page (max 50 to prevent query exhaustion)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 10;

  @ApiPropertyOptional({ description: 'Filter matches by player username' })
  @IsOptional()
  @IsString()
  username?: string;

  @ApiPropertyOptional({ enum: MatchResultFilter, description: 'Filter by match outcome' })
  @IsOptional()
  @IsEnum(MatchResultFilter)
  result?: MatchResultFilter;
}
