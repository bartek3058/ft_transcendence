import { Body, Controller, Get, HttpCode, Patch, Post, Req, Res, UnauthorizedException, UseFilters, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthExceptionFilter } from './auth-exception.filter';
import { AuthRequestGuard } from './auth-request.guard';
import { AccountRateLimiter, PASSWORD_CHANGE_LIMIT, USERNAME_CHANGE_LIMIT } from './account-rate-limiter';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { LogoutDto } from './dto/logout.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { AuthenticatedRequest, SessionGuard } from './session.guard';
import { readSessionToken, SESSION_COOKIE, SESSION_COOKIE_OPTIONS } from './session-cookie';
import { SessionService } from './session.service';

// Order on the account routes: IP limit + origin/CSRF (no I/O) -> session -> body validation
// -> per-user limit -> DB / argon2.
@Controller('auth')
@UseFilters(AuthExceptionFilter)
@UseGuards(AuthRequestGuard)
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly sessions: SessionService,
    private readonly accountLimiter: AccountRateLimiter) {}

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

  @Get('session')
  async session(@Req() request: Request) {
    try {
      const user = await this.sessions.authenticate(readSessionToken(request));
      return { user };
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        return { user: null };
      }
      throw error;
    }
  }

  @Get('me')
  @UseGuards(SessionGuard)
  me(@Req() request: AuthenticatedRequest) { return { user: request.account }; }

  @Patch('me')
  @UseGuards(SessionGuard)
  async updateMe(@Body() dto: UpdateAccountDto, @Req() request: AuthenticatedRequest) {
    this.accountLimiter.consume(`username:${request.account.id}`, USERNAME_CHANGE_LIMIT);
    return { user: await this.auth.updateUsername(request.account, dto.username) };
  }

  @Post('password')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async changePassword(@Body() dto: ChangePasswordDto, @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response) {
    this.accountLimiter.consume(`password:${request.account.id}`, PASSWORD_CHANGE_LIMIT);
    const session = await this.auth.changePassword(request.account.id, dto);
    // every other session is gone, this browser keeps going with the new one
    response.cookie(SESSION_COOKIE, session.token, { ...SESSION_COOKIE_OPTIONS, expires: session.expiresAt });
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Body() _dto: LogoutDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.sessions.revoke(readSessionToken(request));
    response.clearCookie(SESSION_COOKIE, SESSION_COOKIE_OPTIONS);
  }
}
