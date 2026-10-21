import { Module } from '@nestjs/common';
import { GameService } from './game.service';
import { AuthModule } from '../auth/auth.module';

//Core Game Module encapsulating the authoritative chess engine and state manager (#106)
@Module({
  imports: [AuthModule],
  providers: [GameService],
  exports: [GameService],
})
export class GameModule {}