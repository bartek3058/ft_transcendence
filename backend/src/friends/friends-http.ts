import { ArgumentsHost, BadRequestException, UnsupportedMediaTypeException, CanActivate, Catch, ExecutionContext, ExceptionFilter, ForbiddenException,
  HttpException, Inject, Injectable } from '@nestjs/common';
import { AUTH_CONFIG, AuthConfig } from '../auth/auth.config';
import { AuthRateLimiter } from '../auth/auth-rate-limiter';
import { AuthRetryException } from '../auth/auth.errors';

@Injectable()
export class FriendsRequestGuard implements CanActivate {
  constructor(@Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    private readonly limiter: AuthRateLimiter) {}
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();
    res.setHeader('Cache-Control', 'no-store');
    this.limiter.consume(`friends:ip:${req.ip}`, 180, 60000);
    if (req.method !== 'GET') {
      if (req.headers.origin !== this.config.origin || req.headers['x-csrf-protection'] !== '1') {
        throw new ForbiddenException({ error: { code: 'REQUEST_ORIGIN_REJECTED', message: 'Invalid origin or CSRF header.' } });
      }
      if (!req.is('application/json')) {
        throw new UnsupportedMediaTypeException({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Use application/json.' } });
      }
      const allowed = context.getHandler().name === 'send' ? ['targetUserId'] : [];
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
        || Object.entries(req.body).some(([key, value]) => !allowed.includes(key) || typeof value !== 'string')) {
        throw new BadRequestException({ error: { code: 'INVALID_INPUT', message: 'Request validation failed.' } });
      }
    }
    return true;
  }
}
@Injectable()
export class FriendsUserLimitGuard implements CanActivate {
  constructor(private readonly limiter: AuthRateLimiter) {}
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    this.limiter.consume(`friends:user:${req.account.id}:${req.method === 'GET' ? 'read' : 'write'}`,
      req.method === 'GET' ? 120 : 30, 60000);
    return true;
  }
}
@Catch()
export class FriendsExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    res.setHeader('Cache-Control', 'no-store');
    if (error instanceof AuthRetryException) res.setHeader('Retry-After', error.retryAfter);
    if (error instanceof HttpException) {
      const body = error.getResponse();
      return res.status(error.getStatus()).json(typeof body === 'object' && 'error' in body ? body : {
        error: { code: 'INVALID_INPUT', message: 'Request validation failed.' },
      });
    }
    res.setHeader('Retry-After', '5');
    return res.status(503).json({ error: { code: 'FRIENDS_UNAVAILABLE', message: 'Friends service is temporarily unavailable.' } });
  }
}
