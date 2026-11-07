import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { GameModule } from '../game/game.module';
import { TournamentRateLimiter } from './http/tournament-rate-limiter';
import { TournamentRequestGuard, TournamentUserLimitGuard } from './http/tournaments-http';
import { TournamentBracketService } from './tournament-bracket.service';
import { TournamentGameService } from './tournament-game.service';
import { TournamentLifecycleService } from './tournament-lifecycle.service';
import { TournamentsController } from './tournaments.controller';
import { TournamentsService } from './tournaments.service';

// GameModule -> GameService (conclusion listener + session creation).
// Dependency is one-way: GameModule never imports TournamentModule.
@Module({
  imports: [AuthModule, DatabaseModule, GameModule],
  controllers: [TournamentsController],
  providers: [
    TournamentBracketService, TournamentGameService, TournamentLifecycleService, TournamentsService,
    TournamentRateLimiter, TournamentRequestGuard, TournamentUserLimitGuard,
  ],
  exports: [TournamentBracketService, TournamentGameService, TournamentLifecycleService],
})
export class TournamentModule {}
