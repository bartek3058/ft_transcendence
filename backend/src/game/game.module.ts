import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GameService } from './game.service';
import { GameGateway } from './game.gateway';

@Module({
  imports: [AuthModule],
  providers: [GameService, GameGateway],
  exports: [GameService],
})
export class GameModule {}
