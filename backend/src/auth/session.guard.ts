import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { SafeAccount } from './auth.repository';
import { readSessionToken } from './session-cookie';
import { SessionService } from './session.service';

export interface AuthenticatedRequest extends Request { account: SafeAccount }

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    request.account = await this.sessions.authenticate(readSessionToken(request));
    return true;
  }
}
