import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GameModule } from '../game/game.module';
import { StockfishService } from './stockfish.service';
import { AiGameService } from './ai-game.service';
import { AiGameGateway } from './ai-game.gateway';

/**
 * AI module: the Stockfish engine (AI opponent + move hints) and the human-vs-AI
 * game flow + its WebSocket gateway. AuthModule gives us SessionService (socket
 * auth), GameModule gives us GameService (authoritative sessions); Prisma comes
 * from the @Global DatabaseModule.
 */
@Module({
  imports: [AuthModule, GameModule],
  providers: [StockfishService, AiGameService, AiGameGateway],
  exports: [StockfishService, AiGameService],
})
export class AiModule {}
