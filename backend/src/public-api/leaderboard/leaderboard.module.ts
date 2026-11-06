import { Module } from '@nestjs/common';
import { LeaderboardController } from './leaderboard.controller';
import { LeaderboardService } from './leaderboard.service';
import { DatabaseModule } from '../../database/database.module';
import { ApiKeyModule } from '../api-key/api-key.module';

@Module({
  imports: [DatabaseModule, ApiKeyModule],
  controllers: [LeaderboardController],
  providers: [LeaderboardService],
  exports: [LeaderboardService],
})
export class LeaderboardModule {}
