import { Injectable } from '@nestjs/common';
import { SlidingWindowLimiter } from '../../common/sliding-window-limiter';
import { PublicApiRetryException } from './public-api.errors';

/** Public API limiter: shared sliding-window logic + public API error format. */
@Injectable()
export class ApiKeyRateLimiter {
  private readonly limiter = new SlidingWindowLimiter((status, retryAfter, limit, windowMs) =>
    status === 503
      ? new PublicApiRetryException(503, 'PUBLIC_API_BUSY',
        'Rate limiting system is at capacity. Please retry shortly.', 30)
      : new PublicApiRetryException(429, 'RATE_LIMITED',
        `Rate limit exceeded. Maximum ${limit} requests per ${windowMs / 1000}s.`, retryAfter));

  consume(key: string, limit = 60, windowMs = 60000, now = Date.now()): void {
    this.limiter.consume(key, limit, windowMs, now);
  }
}
