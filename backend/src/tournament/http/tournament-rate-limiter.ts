import { Injectable } from '@nestjs/common';
import { SlidingWindowLimiter } from '../../common/sliding-window-limiter';
import { TournamentHttpError } from './tournament.errors';

@Injectable()
export class TournamentRateLimiter {
  private readonly limiter = new SlidingWindowLimiter((status, retryAfter) => status === 503
    ? new TournamentHttpError(503, 'TOURNAMENTS_BUSY', 'Tournaments are busy. Please retry shortly.', retryAfter)
    : new TournamentHttpError(429, 'RATE_LIMITED', 'Too many tournament requests.', retryAfter));

  consume(key: string, limit: number, windowMs: number, now = Date.now()): void {
    this.limiter.consume(key, limit, windowMs, now);
  }
}
