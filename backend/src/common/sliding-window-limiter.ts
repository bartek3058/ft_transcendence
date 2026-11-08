/**
 * True sliding-window rate limiter (rolling timestamps, no fixed-window reset).
 * Framework-free: callers decide which exception is thrown on rejection.
 */
export type LimiterRejection = (
  status: 429 | 503, retryAfterSeconds: number, limit: number, windowMs: number,
) => Error;

interface Bucket { windowMs: number; timestamps: number[] }

export class SlidingWindowLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly reject: LimiterRejection, private readonly capacity = 10000) {}

  consume(key: string, limit: number, windowMs: number, now = Date.now()): void {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.capacity) this.evictExpired(now);
      if (this.buckets.size >= this.capacity) throw this.reject(503, 30, limit, windowMs);
      bucket = { windowMs, timestamps: [] };
      this.buckets.set(key, bucket);
    }
    const { timestamps } = bucket;
    const windowStart = now - windowMs;
    while (timestamps.length > 0 && timestamps[0] <= windowStart) timestamps.shift();
    if (timestamps.length >= limit) {
      const retryAfter = Math.max(1, Math.ceil((timestamps[0] + windowMs - now) / 1000));
      throw this.reject(429, retryAfter, limit, windowMs);
    }
    timestamps.push(now);
  }

  // Each bucket is pruned with its own window, never the caller's.
  private evictExpired(now: number): void {
    for (const [key, bucket] of this.buckets) {
      const alive = bucket.timestamps.filter((t) => t > now - bucket.windowMs);
      if (alive.length === 0) this.buckets.delete(key);
      else bucket.timestamps = alive;
    }
  }
}
