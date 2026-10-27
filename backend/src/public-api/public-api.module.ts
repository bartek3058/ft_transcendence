import { Module } from '@nestjs/common';
import { ApiKeyModule } from './api-key/api-key.module';
import { ApiKeyRateLimiter } from './common/api-key-rate-limiter';
import { ApiKeyGuard } from './common/api-key.guard';
import { PublicApiExceptionFilter } from './common/public-api-exception.filter';

@Module({
  imports: [ApiKeyModule],
  providers: [ApiKeyRateLimiter, ApiKeyGuard, PublicApiExceptionFilter],
  exports: [ApiKeyModule, ApiKeyRateLimiter, ApiKeyGuard, PublicApiExceptionFilter],
})
export class PublicApiModule {}
