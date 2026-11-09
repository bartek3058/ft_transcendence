import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GameModule } from '../game/game.module';
import { StockfishService } from './stockfish.service';
import { AiGameService } from './ai-game.service';
import { AiGameGateway } from './ai-game.gateway';

@Module({
  imports: [AuthModule, GameModule],
  providers: [StockfishService, AiGameService, AiGameGateway],
  exports: [StockfishService, AiGameService],
})
export class AiModule {}
