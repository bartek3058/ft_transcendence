import { Injectable } from '@nestjs/common';
import { PublicApiRetryException } from './public-api.errors';

interface RateWindow {
  count: number;
  expiresAt: number;
}

@Injectable()
export class ApiKeyRateLimiter {
  private readonly windows = new Map<string, RateWindow>();
  private readonly capacity = 10000;

  consume(key: string, limit = 60, windowMs = 60000, now = Date.now()): void {
    let entry = this.windows.get(key);
    if (entry && entry.expiresAt <= now) {
      this.windows.delete(key);
      entry = undefined;
    }

    if (!entry) {
      if (this.windows.size >= this.capacity) {
        for (const [storedKey, value] of this.windows) {
          if (value.expiresAt <= now) this.windows.delete(storedKey);
        }
        if (this.windows.size >= this.capacity) {
          throw new PublicApiRetryException(
            503,
            'PUBLIC_API_BUSY',
            'Rate limiting system is at capacity. Please retry shortly.',
            30,
          );
        }
      }
      entry = { count: 0, expiresAt: now + windowMs };
      this.windows.set(key, entry);
    }

    if (entry.count >= limit) {
      const retryAfter = Math.max(1, Math.ceil((entry.expiresAt - now) / 1000));
      throw new PublicApiRetryException(
        429,
        'RATE_LIMITED',
        `Rate limit exceeded. Maximum ${limit} requests per ${windowMs / 1000}s.`,
        retryAfter,
      );
    }

    entry.count++;
  }
}
