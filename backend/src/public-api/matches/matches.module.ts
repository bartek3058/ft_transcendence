import { Module } from '@nestjs/common';
import { MatchesController } from './matches.controller';
import { MatchesService } from './matches.service';
import { DatabaseModule } from '../../database/database.module';
import { ApiKeyModule } from '../api-key/api-key.module';

@Module({
  imports: [DatabaseModule, ApiKeyModule],
  controllers: [MatchesController],
  providers: [MatchesService],
  exports: [MatchesService],
})
export class MatchesModule {}
