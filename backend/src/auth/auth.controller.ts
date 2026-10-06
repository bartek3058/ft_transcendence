import { Body, Controller, Get, HttpCode, Post, Req, Res, UseFilters, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthExceptionFilter } from './auth-exception.filter';
import { AuthRequestGuard } from './auth-request.guard';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { LogoutDto } from './dto/logout.dto';
import { AuthenticatedRequest, SessionGuard } from './session.guard';
import { readSessionToken, SESSION_COOKIE, SESSION_COOKIE_OPTIONS } from './session-cookie';
import { SessionService } from './session.service';

@Controller('auth')
@UseFilters(AuthExceptionFilter)
@UseGuards(AuthRequestGuard)
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly sessions: SessionService) {}

  @Post('register')
  async register(@Body() dto: RegisterDto) {
    return { user: await this.auth.register(dto) };
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const result = await this.auth.login(dto, readSessionToken(request));
    response.cookie(SESSION_COOKIE, result.session.token, {
      ...SESSION_COOKIE_OPTIONS, expires: result.session.expiresAt,
    });
    return { user: result.user };
  }

  @Get('me')
  @UseGuards(SessionGuard)
  me(@Req() request: AuthenticatedRequest) { return { user: request.account }; }

  @Post('logout')
  @HttpCode(204)
  async logout(@Body() _dto: LogoutDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.sessions.revoke(readSessionToken(request));
    response.clearCookie(SESSION_COOKIE, SESSION_COOKIE_OPTIONS);
  }
}
