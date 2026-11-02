import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GameService } from './game.service';
import { GameGateway } from './game.gateway';
import { RatingModule } from '../rating/rating.module';

@Module({
  imports: [AuthModule, RatingModule],
  providers: [GameService, GameGateway],
  exports: [GameService],
})
export class GameModule {}
