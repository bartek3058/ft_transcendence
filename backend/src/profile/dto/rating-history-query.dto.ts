import { Type } from "class-transformer";
import { IsInt, IsOptional, Max, Min } from "class-validator";

export const RATING_HISTORY_DEFAULT_LIMIT = 100;
export const RATING_HISTORY_MAX_LIMIT = 500;

export class RatingHistoryQueryDto {
  // the latest N rated games
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(RATING_HISTORY_MAX_LIMIT)
  limit?: number = RATING_HISTORY_DEFAULT_LIMIT;
}
