import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RatingService } from './rating.service';

@ApiTags('Leaderboard')
@Controller('leaderboard')
export class RatingController {
  constructor(private readonly ratingService: RatingService) {}

  @Get()
  @ApiOperation({
    summary: 'Get web leaderboard entries',
    description: 'Returns players ordered by ELO rating for the frontend leaderboard view.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Number of entries to return (default: 20)' })
  @ApiQuery({ name: 'offset', required: false, type: Number, description: 'Offset for pagination (default: 0)' })
  @ApiResponse({ status: 200, description: 'Leaderboard entries list' })
  async getLeaderboard(
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.ratingService.getLeaderboard(limit, offset);
  }
}
