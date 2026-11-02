import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { AuthenticatedRequest, SessionGuard } from "../auth/session.guard";
import { ProfileService } from "./profile.service";
import { HistoryQueryDto } from "./dto/history-query.dto";

@Controller("profile")
@UseGuards(SessionGuard)
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @Get("me")
  async me(@Req() request: AuthenticatedRequest) {
    return this.profile.getMyProfile(request.account.id);
  }

  @Get("me/games")
  async myGames(
    @Req() request: AuthenticatedRequest,
    @Query() query: HistoryQueryDto,
  ) {
    return this.profile.getMyGames(request.account.id, query.page, query.limit);
  }
}
