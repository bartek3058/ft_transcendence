import { Injectable } from '@nestjs/common';
import { PublicApiRetryException } from './public-api.errors';

/**
 * True sliding-window rate limiter.
 * Tracks an array of request timestamps per bucket key and counts only
 * those falling within the rolling window (now - windowMs, now].
 * This prevents the 2x boundary-burst vulnerability of fixed-window counters.
 */
@Injectable()
export class ApiKeyRateLimiter {
  private readonly buckets = new Map<string, number[]>();
  private readonly capacity = 10000;

  consume(key: string, limit = 60, windowMs = 60000, now = Date.now()): void {
    let timestamps = this.buckets.get(key);

    if (!timestamps) {
      // Evict expired buckets if at capacity
      if (this.buckets.size >= this.capacity) {
        for (const [storedKey, storedTimestamps] of this.buckets) {
          const filtered = storedTimestamps.filter((t) => t > now - windowMs);
          if (filtered.length === 0) {
            this.buckets.delete(storedKey);
          } else {
            this.buckets.set(storedKey, filtered);
          }
        }
        if (this.buckets.size >= this.capacity) {
          throw new PublicApiRetryException(
            503,
            'PUBLIC_API_BUSY',
            'Rate limiting system is at capacity. Please retry shortly.',
            30,
          );
        }
      }
      timestamps = [];
      this.buckets.set(key, timestamps);
    }

    // Sliding window: remove timestamps older than the rolling window
    const windowStart = now - windowMs;
    while (timestamps.length > 0 && timestamps[0] <= windowStart) {
      timestamps.shift();
    }

    if (timestamps.length >= limit) {
      // Oldest timestamp in window determines when the next slot opens
      const oldestInWindow = timestamps[0];
      const retryAfter = Math.max(1, Math.ceil((oldestInWindow + windowMs - now) / 1000));
      throw new PublicApiRetryException(
        429,
        'RATE_LIMITED',
        `Rate limit exceeded. Maximum ${limit} requests per ${windowMs / 1000}s.`,
        retryAfter,
      );
    }

    timestamps.push(now);
  }
}
