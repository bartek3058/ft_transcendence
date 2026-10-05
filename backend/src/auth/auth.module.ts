import { Module } from '@nestjs/common';
import { PasswordService } from './password.service';

// HTTP routes arrive with database-backed account and session services.
@Module({ providers: [PasswordService], exports: [PasswordService] })
export class AuthModule {}
