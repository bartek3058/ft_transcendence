import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { RatingModule } from './rating/rating.module';

@Module({
  imports: [DatabaseModule, HealthModule, AuthModule, RatingModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
