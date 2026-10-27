import { Module } from '@nestjs/common';
import { ApiKeyModule } from './api-key/api-key.module';
import { MatchesModule } from './matches/matches.module';

@Module({
  imports: [ApiKeyModule, MatchesModule],
  exports: [ApiKeyModule, MatchesModule],
})
export class PublicApiModule {}
