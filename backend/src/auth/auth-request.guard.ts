import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Request } from 'express';
import { AUTH_CONFIG, AuthConfig } from './auth.config';
import { AuthRateLimiter } from './auth-rate-limiter';
import { normalizeIdentity } from './validation/input-rules';

@Injectable()
export class AuthRequestGuard implements CanActivate {
  constructor(@Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    private readonly limiter: AuthRateLimiter) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const operation = context.getHandler().name;
    const client = request.ip ?? request.socket.remoteAddress ?? 'unknown';
    this.limiter.consume(`request:${client}`, 60, 60000);
    if (request.method !== 'GET') {
      if (request.headers.origin !== this.config.origin || request.headers['x-csrf-protection'] !== '1') {
        throw new ForbiddenException({ error: {
          code: 'REQUEST_ORIGIN_REJECTED', message: 'Request origin or CSRF header is invalid.',
        } });
      }
    }
    if (operation === 'login' || operation === 'register') {
      this.limiter.consume(`credentials:${client}`, 20, 15 * 60000);
      const email = normalizeIdentity(request.body?.email);
      if (typeof email === 'string' && email.length <= 254) {
        const key = createHash('sha256').update(email).digest('hex');
        this.limiter.consume(`account:${operation}:${key}`, 10, 15 * 60000);
      }
    }
    return true;
  }
}
