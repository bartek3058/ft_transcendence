import { Module } from '@nestjs/common';
import { GameService } from './game.service';

//Core Game Module encapsulating the authoritative chess engine and state manager (#106)
@Module({
  providers: [GameService],
  exports: [GameService],
})
export class GameModule {}