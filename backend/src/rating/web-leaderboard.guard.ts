import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { ApiKeyRateLimiter } from '../public-api/common/api-key-rate-limiter';

/**
 * Pre-DB, IP-keyed sliding-window limit for the unauthenticated web leaderboard.
 * Runs as a guard, i.e. before the DB query in the handler (constitution §8 order).
 * Uses its own ApiKeyRateLimiter instance (provided in RatingModule), so its
 * buckets never compete with Public API keys.
 */
@Injectable()
export class WebLeaderboardGuard implements CanActivate {
  constructor(private readonly limiter: ApiKeyRateLimiter) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const client = request.ip ?? request.socket.remoteAddress ?? 'unknown';
    this.limiter.consume(`web-leaderboard:${client}`, 60, 60000);
    return true;
  }
}
