import { Module } from '@nestjs/common';
import { RatingService } from './rating.service';
import { RatingController } from './rating.controller';
import { WebLeaderboardGuard } from './web-leaderboard.guard';
import { ApiKeyRateLimiter } from '../public-api/common/api-key-rate-limiter';

@Module({
  controllers: [RatingController],
  providers: [RatingService, WebLeaderboardGuard, ApiKeyRateLimiter],
  exports: [RatingService],
})
export class RatingModule {}
