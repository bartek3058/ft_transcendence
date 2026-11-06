import { Module } from '@nestjs/common';
import { ApiKeyModule } from './api-key/api-key.module';
import { MatchesModule } from './matches/matches.module';
import { LeaderboardModule } from './leaderboard/leaderboard.module';

@Module({
  imports: [ApiKeyModule, MatchesModule, LeaderboardModule],
  exports: [ApiKeyModule, MatchesModule, LeaderboardModule],
})
export class PublicApiModule {}
