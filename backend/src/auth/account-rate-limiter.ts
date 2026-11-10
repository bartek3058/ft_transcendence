import { Injectable } from '@nestjs/common';
import { SlidingWindowLimiter } from '../common/sliding-window-limiter';
import { AuthRetryException } from './auth.errors';

// Per-user limits for account changes, keyed on the session user (sliding window).
export const USERNAME_CHANGE_LIMIT = { limit: 5, windowMs: 60 * 60_000 };
// also caps current-password guesses from a stolen session
export const PASSWORD_CHANGE_LIMIT = { limit: 5, windowMs: 15 * 60_000 };

@Injectable()
export class AccountRateLimiter {
  private readonly limiter = new SlidingWindowLimiter((status, retryAfter) => status === 503
    ? new AuthRetryException(503, 'AUTH_BUSY', 'Authentication is busy. Please retry shortly.', retryAfter)
    : new AuthRetryException(429, 'RATE_LIMITED', 'Too many account changes. Please wait.', retryAfter));

  consume(key: string, rule: { limit: number; windowMs: number }, now = Date.now()): void {
    this.limiter.consume(key, rule.limit, rule.windowMs, now);
  }
}
