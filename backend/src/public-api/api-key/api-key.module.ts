import { Module } from '@nestjs/common';
import { ApiKeyService } from './api-key.service';
import { ApiKeysController } from './api-keys.controller';
import { DatabaseModule } from '../../database/database.module';
import { ApiKeyRateLimiter } from '../common/api-key-rate-limiter';
import { ApiKeyGuard } from '../common/api-key.guard';
import { PublicApiExceptionFilter } from '../common/public-api-exception.filter';

@Module({
  imports: [DatabaseModule],
  controllers: [ApiKeysController],
  providers: [ApiKeyService, ApiKeyRateLimiter, ApiKeyGuard, PublicApiExceptionFilter],
  exports: [ApiKeyService, ApiKeyRateLimiter, ApiKeyGuard, PublicApiExceptionFilter],
})
export class ApiKeyModule {}
