import { Controller, Get, Query } from '@nestjs/common';
import { RatingService } from './rating.service';
import { LeaderboardQueryDto } from './dto/leaderboard-query.dto';

// Public ranking endpoints. The leaderboard is open - no login needed to see it.
@Controller('leaderboard')
export class RatingController {
  constructor(private readonly rating: RatingService) {}

  @Get()
  async leaderboard(@Query() query: LeaderboardQueryDto) {
    const entries = await this.rating.getLeaderboard(query.limit, query.offset);
    return { entries };
  }
}
