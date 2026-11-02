import { Controller, Get, Param, Query, UseFilters, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { LeaderboardService } from './leaderboard.service';
import { PublicLeaderboardQueryDto } from './dto/leaderboard-query.dto';
import {
  GlobalStatsDto,
  PaginatedLeaderboardDto,
  PlayerRankingDto,
} from './dto/leaderboard-response.dto';
import { ApiKeyGuard } from '../common/api-key.guard';
import { PublicApiExceptionFilter } from '../common/public-api-exception.filter';

@ApiTags('Leaderboard')
@ApiSecurity('api-key')
@UseGuards(ApiKeyGuard)
@UseFilters(PublicApiExceptionFilter)
@Controller('v1/leaderboard')
export class LeaderboardController {
  constructor(private readonly leaderboardService: LeaderboardService) {}

  @Get()
  @ApiOperation({
    summary: 'Get global leaderboard',
    description: 'Returns a paginated list of players ranked by ELO rating in descending order, including individual win/loss records and win percentages.',
  })
  @ApiResponse({ status: 200, description: 'Paginated leaderboard ranking', type: PaginatedLeaderboardDto })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async getLeaderboard(@Query() query: PublicLeaderboardQueryDto): Promise<PaginatedLeaderboardDto> {
    return this.leaderboardService.getLeaderboard(query.page, query.limit);
  }

  @Get('stats')
  @ApiOperation({
    summary: 'Get global platform statistics',
    description: 'Returns aggregate platform-wide metrics including total registered players, completed matches, average ELO rating, and highest-rated player.',
  })
  @ApiResponse({ status: 200, description: 'Global statistics snapshot', type: GlobalStatsDto })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async getStats(): Promise<GlobalStatsDto> {
    return this.leaderboardService.getGlobalStats();
  }

  @Get('players/:username')
  @ApiOperation({
    summary: 'Get player ranking by username',
    description: 'Looks up a specific player by username and returns their current global ranking, ELO rating, games played, and win rate.',
  })
  @ApiParam({ name: 'username', description: 'Username of the player to look up' })
  @ApiResponse({ status: 200, description: 'Player ranking breakdown', type: PlayerRankingDto })
  @ApiResponse({ status: 400, description: 'Invalid username format' })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  @ApiResponse({ status: 404, description: 'Player not found' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async getPlayerRanking(@Param('username') username: string): Promise<PlayerRankingDto> {
    return this.leaderboardService.getPlayerRanking(username);
  }
}
