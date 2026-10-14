import { Module } from '@nestjs/common';
import { PasswordService } from './password.service';
import { AUTH_CONFIG, loadAuthConfig } from './auth.config';
import { AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { PrismaAuthRepository } from './prisma-auth.repository';
import { DatabaseModule } from '../database/database.module';
import { AuthService } from './auth.service';
import { UsersService } from './users.service';
import { SessionService } from './session.service';
import { SessionGuard } from './session.guard';
import { AuthRequestGuard } from './auth-request.guard';
import { AuthRateLimiter } from './auth-rate-limiter';

@Module({
  imports: [DatabaseModule],
  controllers: [AuthController],
  providers: [PasswordService, AuthService, UsersService, SessionService, SessionGuard, AuthRequestGuard, AuthRateLimiter,
    { provide: AUTH_CONFIG, useFactory: loadAuthConfig },
    { provide: AuthRepository, useClass: PrismaAuthRepository },
  ],
  exports: [PasswordService, SessionGuard, SessionService, AUTH_CONFIG],
})
export class AuthModule {}
