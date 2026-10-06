import { Module } from '@nestjs/common';
import { PasswordService } from './password.service';
import { AUTH_CONFIG, loadAuthConfig } from './auth.config';
import { AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { UnavailableAuthRepository } from './unavailable-auth.repository';
import { AuthService } from './auth.service';
import { UsersService } from './users.service';
import { SessionService } from './session.service';
import { SessionGuard } from './session.guard';
import { AuthRequestGuard } from './auth-request.guard';
import { AuthRateLimiter } from './auth-rate-limiter';

@Module({
  controllers: [AuthController],
  providers: [PasswordService, AuthService, UsersService, SessionService, SessionGuard, AuthRequestGuard, AuthRateLimiter,
    { provide: AUTH_CONFIG, useFactory: loadAuthConfig },
    // Replace this binding with the real Prisma adapter when DatabaseModule lands.
    { provide: AuthRepository, useClass: UnavailableAuthRepository },
  ],
  exports: [PasswordService, SessionGuard, SessionService, AUTH_CONFIG],
})
export class AuthModule {}
