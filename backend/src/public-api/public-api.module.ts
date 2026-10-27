import { Module } from '@nestjs/common';
import { ApiKeyModule } from './api-key/api-key.module';

@Module({
  imports: [ApiKeyModule],
  exports: [ApiKeyModule],
})
export class PublicApiModule {}
