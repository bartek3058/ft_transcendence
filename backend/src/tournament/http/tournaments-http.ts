import { ArgumentsHost, CanActivate, Catch, ExceptionFilter, ExecutionContext, HttpException, Inject,
  Injectable, Logger, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';
import { AUTH_CONFIG, AuthConfig } from '../../auth/auth.config';
import { AuthenticatedRequest } from '../../auth/session.guard';
import { hasErrorEnvelope } from '../../common/http-error-envelope';
import { TournamentHttpError } from './tournament.errors';
import { TournamentRateLimiter } from './tournament-rate-limiter';

export const TOURNAMENT_LIMITS = Object.freeze({ windowMs: 60_000, ip: 180, userRead: 120, userWrite: 30 });

// Same shape ParseUUIDPipe accepts; checked here so a malformed id never reaches the session lookup.
const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BODY_KEYS = 'tournaments:body-keys';

/** Top-level JSON keys a mutating handler accepts; handlers without it accept only `{}`. */
export const TournamentBody = (...keys: string[]) => SetMetadata(BODY_KEYS, keys);

/**
 * Runs before SessionGuard. Order:
 * (1) zero-I/O format checks -> (2) pre-auth per-IP sliding-window limit.
 */
@Injectable()
export class TournamentRequestGuard implements CanActivate {
  constructor(@Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    private readonly limiter: TournamentRateLimiter,
    private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    context.switchToHttp().getResponse<Response>().setHeader('Cache-Control', 'no-store');

    // Every route param (:id, :matchId) is a UUID.
    if (Object.values(req.params ?? {}).some((value) => !UUID_FORMAT.test(value))) {
      throw new TournamentHttpError(400, 'INVALID_ID', 'Ids must be UUIDs.');
    }
    if (req.method !== 'GET') this.checkWrite(context, req);

    this.limiter.consume(`tournaments:ip:${req.ip}`, TOURNAMENT_LIMITS.ip, TOURNAMENT_LIMITS.windowMs);
    return true;
  }

  private checkWrite(context: ExecutionContext, req: Request): void {
    if (req.headers.origin !== this.config.origin || req.headers['x-csrf-protection'] !== '1') {
      throw new TournamentHttpError(403, 'REQUEST_ORIGIN_REJECTED', 'Invalid origin or CSRF header.');
    }
    if (!req.is('application/json')) {
      throw new TournamentHttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json.');
    }
    const allowed = this.reflector.get<string[]>(BODY_KEYS, context.getHandler()) ?? [];
    const body: unknown = req.body;
    // Own-key check also rejects `__proto__` / `constructor` keys; nested values are refused
    // before class-transformer can recurse into them. Field types are left to the DTOs.
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.entries(body).some(([key, value]) => !allowed.includes(key)
        || (value !== null && typeof value === 'object'))) {
      throw new TournamentHttpError(400, 'INVALID_INPUT', 'Request validation failed.');
    }
  }
}

/** Runs after SessionGuard: per-user limits, separate read and write buckets. */
@Injectable()
export class TournamentUserLimitGuard implements CanActivate {
  constructor(private readonly limiter: TournamentRateLimiter) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const write = req.method !== 'GET';
    this.limiter.consume(`tournaments:user:${req.account.id}:${write ? 'write' : 'read'}`,
      write ? TOURNAMENT_LIMITS.userWrite : TOURNAMENT_LIMITS.userRead, TOURNAMENT_LIMITS.windowMs);
    return true;
  }
}

// Fixed texts for framework / engine exceptions: never echo internal messages to clients.
const GENERIC: Record<number, readonly [string, string]> = {
  400: ['INVALID_INPUT', 'Request validation failed.'],
  401: ['UNAUTHENTICATED', 'Please log in.'],
  403: ['FORBIDDEN', 'You are not allowed to do this.'],
  404: ['TOURNAMENT_NOT_FOUND', 'Tournament not found.'],
  409: ['TOURNAMENT_CONFLICT', 'Tournament state does not allow this action.'],
};

@Catch()
export class TournamentsExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(TournamentsExceptionFilter.name);

  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    res.setHeader('Cache-Control', 'no-store');

    if (error instanceof HttpException) {
      if (error instanceof TournamentHttpError && error.retryAfter !== undefined) {
        res.setHeader('Retry-After', String(error.retryAfter));
      }
      const status = error.getStatus();
      const body = error.getResponse();
      if (hasErrorEnvelope(body)) return res.status(status).json(body);
      const [code, message] = GENERIC[status] ?? ['REQUEST_FAILED', 'Request failed.'];
      return res.status(status).json({ error: { code, message } });
    }
    // Safety net only: services map expected unique violations to explicit 409 codes themselves.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const [code, message] = GENERIC[409];
      return res.status(409).json({ error: { code, message } });
    }
    this.logger.error(error instanceof Error ? error.stack ?? error.message : String(error));
    res.setHeader('Retry-After', '5');
    return res.status(503).json({ error: {
      code: 'TOURNAMENTS_UNAVAILABLE', message: 'Tournaments are temporarily unavailable.',
    } });
  }
}
