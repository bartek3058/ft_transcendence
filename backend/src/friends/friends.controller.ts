import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, UseFilters, UseGuards } from '@nestjs/common';
import { SessionGuard, AuthenticatedRequest } from '../auth/session.guard';
import { LogoutDto } from '../auth/dto/logout.dto';
import { FriendRequestDto, PageDto, RequestsDto, SearchDto } from './friends.dto';
import { FriendsService } from './friends.service';
import { FriendsExceptionFilter, FriendsRequestGuard, FriendsUserLimitGuard } from './friends-http';

@Controller('friends')
@UseFilters(FriendsExceptionFilter)
@UseGuards(FriendsRequestGuard, SessionGuard, FriendsUserLimitGuard)
export class FriendsController {
  constructor(private readonly friends: FriendsService) {}
  @Get() list(@Req() req: AuthenticatedRequest, @Query() q: PageDto) { return this.friends.list(req.account.id, q); }
  @Get('requests') requests(@Req() req: AuthenticatedRequest, @Query() q: RequestsDto) { return this.friends.requests(req.account.id, q); }
  @Post('requests') send(@Req() req: AuthenticatedRequest, @Body() dto: FriendRequestDto) {
    return this.friends.send(req.account.id, dto.targetUserId);
  }
  @Post('requests/:id/accept') @HttpCode(204)
  async accept(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() _body: LogoutDto) {
    await this.friends.accept(req.account.id, id);
  }
  @Delete('requests/:id') @HttpCode(204)
  async cancel(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string, @Body() _body: LogoutDto) {
    await this.friends.removeRequest(req.account.id, id);
  }
  @Delete(':friendUserId') @HttpCode(204)
  async remove(@Req() req: AuthenticatedRequest, @Param('friendUserId', ParseUUIDPipe) id: string, @Body() _body: LogoutDto) {
    await this.friends.removeFriend(req.account.id, id);
  }
}
@Controller('users')
@UseFilters(FriendsExceptionFilter)
@UseGuards(FriendsRequestGuard, SessionGuard, FriendsUserLimitGuard)
export class FriendsUsersController {
  constructor(private readonly friends: FriendsService) {}
  @Get('search') search(@Req() req: AuthenticatedRequest, @Query() q: SearchDto) {
    return this.friends.search(req.account.id, q);
  }
  @Get(':id') profile(@Param('id', ParseUUIDPipe) id: string) { return this.friends.profile(id); }
}
