import { Injectable } from '@nestjs/common';
import { AuthRetryException } from './auth.errors';

interface Window { count: number; expiresAt: number }

@Injectable()
export class AuthRateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly capacity = 10000;

  consume(key: string, limit: number, windowMs: number, now = Date.now()): void {
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
          throw new AuthRetryException(503, 'AUTH_BUSY', 'Authentication is busy. Please retry shortly.', 60);
        }
      }
      entry = { count: 0, expiresAt: now + windowMs };
      this.windows.set(key, entry);
    }
    if (entry.count >= limit) {
      throw new AuthRetryException(429, 'RATE_LIMITED', 'Too many authentication requests.',
        Math.max(1, Math.ceil((entry.expiresAt - now) / 1000)));
    }
    entry.count++;
  }
}
