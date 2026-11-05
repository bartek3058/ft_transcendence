import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { TournamentBracketService } from './tournament-bracket.service';

@Module({
  imports: [DatabaseModule],
  providers: [TournamentBracketService],
  exports: [TournamentBracketService],
})
export class TournamentModule {}
