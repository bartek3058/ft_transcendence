import { Controller, Get, Query, UseFilters, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RatingService } from './rating.service';
import { WebLeaderboardQueryDto } from './dto/web-leaderboard-query.dto';
import { WebLeaderboardGuard } from './web-leaderboard.guard';
import { PublicApiExceptionFilter } from '../public-api/common/public-api-exception.filter';

@ApiTags('Web Leaderboard')
@UseGuards(WebLeaderboardGuard)
@UseFilters(PublicApiExceptionFilter)
@Controller('leaderboard')
export class RatingController {
  constructor(private readonly ratingService: RatingService) {}

  @Get()
  @ApiOperation({
    summary: 'Get web leaderboard entries',
    description: 'Returns players ordered by ELO rating for the frontend leaderboard view. Rate limited to 60 req/min per IP.',
  })
  @ApiResponse({ status: 200, description: 'Leaderboard entries list' })
  @ApiResponse({ status: 400, description: 'Invalid limit or offset' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async getLeaderboard(@Query() query: WebLeaderboardQueryDto) {
    return this.ratingService.getLeaderboard(query.limit, query.offset);
  }
}
