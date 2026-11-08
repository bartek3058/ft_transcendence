import {
  Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, UseFilters, UseGuards,
} from '@nestjs/common';
import { AuthenticatedRequest, SessionGuard } from '../auth/session.guard';
import { CreateTournamentDto } from './dto/create-tournament.dto';
import { ListTournamentsQueryDto } from './dto/list-tournaments-query.dto';
import {
  TournamentBody, TournamentRequestGuard, TournamentsExceptionFilter, TournamentUserLimitGuard,
} from './http/tournaments-http';
import { TournamentCheckInService } from './tournament-check-in.service';
import { TournamentsService } from './tournaments.service';

// Guard order: id format + per-IP limit (no I/O) -> session -> per-user limit -> handler (DB).
// Route params are already UUID-checked by TournamentRequestGuard; POST routes without
// @TournamentBody accept only `{}`.
@Controller('tournaments')
@UseFilters(TournamentsExceptionFilter)
@UseGuards(TournamentRequestGuard, SessionGuard, TournamentUserLimitGuard)
export class TournamentsController {
  constructor(private readonly tournaments: TournamentsService,
    private readonly checkIns: TournamentCheckInService) {}

  @Post()
  @TournamentBody('title', 'description', 'maxParticipants', 'registrationDeadline')
  create(@Req() req: AuthenticatedRequest, @Body() dto: CreateTournamentDto) {
    return this.tournaments.create(req.account.id, dto);
  }

  @Get()
  list(@Query() query: ListTournamentsQueryDto) {
    return this.tournaments.list(query);
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.tournaments.detail(id);
  }

  @Post(':id/join') @HttpCode(200)
  join(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.tournaments.join(req.account.id, id);
  }

  @Post(':id/leave') @HttpCode(200)
  leave(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.tournaments.leave(req.account.id, id);
  }

  @Post(':id/close-registration') @HttpCode(200)
  closeRegistration(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.tournaments.closeRegistration(req.account.id, id);
  }

  @Post(':id/cancel') @HttpCode(200)
  cancel(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.tournaments.cancel(req.account.id, id);
  }

  @Post(':id/matches/:matchId/check-in') @HttpCode(200)
  checkIn(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string,
    @Param('matchId', ParseUUIDPipe) matchId: string) {
    return this.checkIns.checkIn(req.account.id, id, matchId);
  }
}
