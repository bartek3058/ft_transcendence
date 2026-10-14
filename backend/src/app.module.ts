import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [DatabaseModule, HealthModule, AuthModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
