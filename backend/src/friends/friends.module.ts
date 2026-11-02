import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { AuthRateLimiter } from '../auth/auth-rate-limiter';
import { FriendsController, FriendsUsersController } from './friends.controller';
import { FriendsService } from './friends.service';
import { PresenceService } from './presence.service';
import { FriendsGateway } from './friends.gateway';
import { FriendsRequestGuard, FriendsUserLimitGuard } from './friends-http';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [FriendsController, FriendsUsersController],
  providers: [FriendsService, PresenceService, FriendsGateway, FriendsRequestGuard, FriendsUserLimitGuard, AuthRateLimiter],
  exports: [FriendsService, PresenceService],
})
export class FriendsModule {}
