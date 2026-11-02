import { Module } from '@nestjs/common';
import { GameService } from './game.service';
import { AuthModule } from '../auth/auth.module';
import { RatingModule } from '../rating/rating.module';

//Core Game Module encapsulating the authoritative chess engine and state manager (#106)
// RatingModule -> RatingService (Elo update on game conclusion, #143).
// PrismaService comes from the global DatabaseModule.
@Module({
  imports: [AuthModule, RatingModule],
  providers: [GameService],
  exports: [GameService],
})
export class GameModule {}
