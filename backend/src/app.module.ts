import { FriendsModule } from "./friends/friends.module";
import { Module } from "@nestjs/common";
import { HealthModule } from "./health/health.module";
import { DatabaseModule } from "./database/database.module";
import { AuthModule } from "./auth/auth.module";
import { RatingModule } from "./rating/rating.module";
import { ProfileModule } from "./profile/profile.module";
import { MatchmakingModule } from "./matchmaking/matchmaking.module";

@Module({
  imports: [
    DatabaseModule,
    FriendsModule,
    HealthModule,
    AuthModule,
    RatingModule,
    ProfileModule,
    MatchmakingModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
