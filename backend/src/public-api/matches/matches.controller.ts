import { Controller, Get, Param, Query, UseFilters, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { MatchesService } from './matches.service';
import { MatchQueryDto } from './dto/match-query.dto';
import { MatchDetailDto, PaginatedMatchesDto } from './dto/match-response.dto';
import { ApiKeyGuard } from '../common/api-key.guard';
import { PublicApiExceptionFilter } from '../common/public-api-exception.filter';

@ApiTags('Matches')
@ApiSecurity('api-key')
@UseGuards(ApiKeyGuard)
@UseFilters(PublicApiExceptionFilter)
@Controller('v1/matches')
export class MatchesController {
  constructor(private readonly matchesService: MatchesService) {}

  @Get()
  @ApiOperation({
    summary: 'List match history',
    description: 'Returns a paginated list of chess matches. Filterable by player username and outcome result.',
  })
  @ApiResponse({ status: 200, description: 'Paginated match history', type: PaginatedMatchesDto })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async listMatches(@Query() query: MatchQueryDto): Promise<PaginatedMatchesDto> {
    return this.matchesService.findMatches(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get match by ID',
    description: 'Returns full match metadata, final outcome, PGN, and ply-by-ply move records.',
  })
  @ApiResponse({ status: 200, description: 'Match details with full move sequence', type: MatchDetailDto })
  @ApiResponse({ status: 400, description: 'Invalid UUID format' })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  @ApiResponse({ status: 404, description: 'Match not found' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async getMatch(@Param('id') id: string): Promise<MatchDetailDto> {
    return this.matchesService.findMatchById(id);
  }
}
