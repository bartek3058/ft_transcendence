import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { GameModule } from '../game/game.module';
import { TournamentBracketService } from './tournament-bracket.service';
import { TournamentGameService } from './tournament-game.service';

// GameModule -> GameService (conclusion listener + session creation).
// Dependency is one-way: GameModule never imports TournamentModule.
@Module({
  imports: [DatabaseModule, GameModule],
  providers: [TournamentBracketService, TournamentGameService],
  exports: [TournamentBracketService, TournamentGameService],
})
export class TournamentModule {}
