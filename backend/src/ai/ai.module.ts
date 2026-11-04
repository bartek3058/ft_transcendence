import { Module } from '@nestjs/common';
import { GameModule } from '../game/game.module';
import { StockfishService } from './stockfish.service';
import { AiGameService } from './ai-game.service';

/**
 * AI module: the Stockfish engine (AI opponent + move hints) and the human-vs-AI
 * game flow. GameModule gives us GameService (authoritative sessions); Prisma
 * comes from the @Global DatabaseModule. The AI game gateway is wired up next.
 */
@Module({
  imports: [GameModule],
  providers: [StockfishService, AiGameService],
  exports: [StockfishService, AiGameService],
})
export class AiModule {}
