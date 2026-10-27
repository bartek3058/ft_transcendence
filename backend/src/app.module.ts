import { Module } from "@nestjs/common";
import { HealthModule } from "./health/health.module";
import { DatabaseModule } from "./database/database.module";
import { AuthModule } from "./auth/auth.module";
import { RatingModule } from "./rating/rating.module";
import { ProfileModule } from "./profile/profile.module";
import { PublicApiModule } from "./public-api/public-api.module";

@Module({
  imports: [
    DatabaseModule,
    HealthModule,
    AuthModule,
    RatingModule,
    ProfileModule,
    PublicApiModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
