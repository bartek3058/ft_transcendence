import {
  Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, UseFilters, UseGuards,
} from '@nestjs/common';
import { AuthenticatedRequest, SessionGuard } from '../auth/session.guard';
import { CreateInvitationDto, InvitationsQueryDto, RespondInvitationDto } from './dto/invitation.dto';
import {
  TournamentBody, TournamentRequestGuard, TournamentsExceptionFilter, TournamentUserLimitGuard,
} from './http/tournaments-http';
import { TournamentInvitationsService } from './tournament-invitations.service';

// Same pipeline as TournamentsController: id format + per-IP limit (no I/O) -> session
// -> per-user limit -> handler (DB). One recipient per request; the UI sends one
// request per selected friend.
@Controller('tournaments')
@UseFilters(TournamentsExceptionFilter)
@UseGuards(TournamentRequestGuard, SessionGuard, TournamentUserLimitGuard)
export class TournamentInvitationsController {
  constructor(private readonly invitations: TournamentInvitationsService) {}

  @Get('invitations/me')
  mine(@Req() req: AuthenticatedRequest, @Query() query: InvitationsQueryDto) {
    return this.invitations.mine(req.account.id, query);
  }

  @Post(':id/invitations')
  @TournamentBody('recipientId')
  invite(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateInvitationDto) {
    return this.invitations.invite(req.account.id, id, dto.recipientId);
  }

  @Post('invitations/:id/respond') @HttpCode(200)
  @TournamentBody('response')
  respond(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RespondInvitationDto) {
    return this.invitations.respond(req.account.id, id, dto.response);
  }
}
