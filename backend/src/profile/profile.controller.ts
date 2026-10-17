import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { AuthenticatedRequest, SessionGuard } from "../auth/session.guard";
import { ProfileService } from "./profile.service";

@Controller("profile")
@UseGuards(SessionGuard)
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @Get("me")
  async me(@Req() request: AuthenticatedRequest) {
    return this.profile.getMyProfile(request.account.id);
  }
}
