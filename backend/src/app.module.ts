import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { DatabaseModule } from './database/database.module';
import { RatingModule } from './rating/rating.module';

@Module({
  imports: [HealthModule, DatabaseModule, RatingModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
