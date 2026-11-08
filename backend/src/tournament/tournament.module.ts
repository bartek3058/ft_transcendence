import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { GameModule } from '../game/game.module';
import { TournamentRateLimiter } from './http/tournament-rate-limiter';
import { TournamentRealtimePayloads } from './realtime/tournament-realtime.payloads';
import { TournamentsGateway } from './realtime/tournaments.gateway';
import { TournamentRequestGuard, TournamentsExceptionFilter, TournamentUserLimitGuard } from './http/tournaments-http';
import { TournamentBracketService } from './tournament-bracket.service';
import { TournamentCheckInService } from './tournament-check-in.service';
import { TournamentCheckInSweeper } from './tournament-check-in.sweeper';
import { TournamentGameService } from './tournament-game.service';
import { TournamentDeadlineScheduler } from './tournament-deadline.scheduler';
import { TournamentEventsPublisher } from './tournament-events.publisher';
import { TournamentInvitationsController } from './tournament-invitations.controller';
import { TournamentInvitationsService } from './tournament-invitations.service';
import { TournamentLifecycleService } from './tournament-lifecycle.service';
import { TournamentsController } from './tournaments.controller';
import { TournamentsService } from './tournaments.service';

// GameModule -> GameService (conclusion listener + session creation).
// Dependency is one-way: GameModule never imports TournamentModule.
@Module({
  imports: [AuthModule, DatabaseModule, GameModule],
  controllers: [TournamentsController, TournamentInvitationsController],
  providers: [
    TournamentBracketService, TournamentGameService, TournamentLifecycleService, TournamentsService,
    TournamentEventsPublisher, TournamentDeadlineScheduler, TournamentCheckInService, TournamentCheckInSweeper,
    TournamentInvitationsService, TournamentRealtimePayloads, TournamentsGateway,
    TournamentRateLimiter,
    TournamentRequestGuard, TournamentUserLimitGuard, TournamentsExceptionFilter,
  ],
  exports: [TournamentBracketService, TournamentGameService, TournamentLifecycleService, TournamentEventsPublisher],
})
export class TournamentModule {}
