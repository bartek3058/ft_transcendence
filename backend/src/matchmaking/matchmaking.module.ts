import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GameModule } from '../game/game.module';
import { QueueService } from './queue.service';
import { MatchmakingService } from './matchmaking.service';
import { MatchmakingGateway } from './matchmaking.gateway';

// AuthModule -> SessionService (socket auth); GameModule -> GameService (create game).
// PrismaService comes from the @Global DatabaseModule.
@Module({
  imports: [AuthModule, GameModule],
  providers: [QueueService, MatchmakingService, MatchmakingGateway],
  exports: [MatchmakingService],
})
export class MatchmakingModule {}
