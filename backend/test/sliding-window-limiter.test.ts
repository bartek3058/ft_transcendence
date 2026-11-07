import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LimiterRejection, SlidingWindowLimiter } from '../src/common/sliding-window-limiter';

class Rejected extends Error {
  constructor(readonly status: number, readonly retryAfter: number) {
    super(`rejected ${status}`);
  }
}

const reject: LimiterRejection = (status, retryAfter) => new Rejected(status, retryAfter);

function rejection(fn: () => void): Rejected {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof Rejected);
    return err;
  }
  assert.fail('expected the limiter to reject');
}

describe('SlidingWindowLimiter', () => {
  it('allows up to the limit, then rejects with 429 and Retry-After', () => {
    const limiter = new SlidingWindowLimiter(reject);
    for (let i = 0; i < 3; i++) limiter.consume('k', 3, 10_000, 1000 + i);
    const err = rejection(() => limiter.consume('k', 3, 10_000, 1003));
    assert.equal(err.status, 429);
    // Oldest timestamp 1000 leaves the window at 11000: ceil((11000 - 1003) / 1000) = 10.
    assert.equal(err.retryAfter, 10);
  });

  it('has no 2x burst across a window boundary', () => {
    const limiter = new SlidingWindowLimiter(reject);
    const window = 1000;
    for (let i = 0; i < 5; i++) limiter.consume('k', 5, window, window - 1);
    // A fixed window would reset at t = window; the rolling window still holds all 5.
    assert.equal(rejection(() => limiter.consume('k', 5, window, window + 1)).status, 429);
  });

  it('frees slots one at a time as timestamps age out', () => {
    const limiter = new SlidingWindowLimiter(reject);
    limiter.consume('k', 2, 1000, 0);
    limiter.consume('k', 2, 1000, 500);
    rejection(() => limiter.consume('k', 2, 1000, 900));
    assert.doesNotThrow(() => limiter.consume('k', 2, 1000, 1000));
    rejection(() => limiter.consume('k', 2, 1000, 1400));
    assert.doesNotThrow(() => limiter.consume('k', 2, 1000, 1500));
  });

  it('keeps buckets independent', () => {
    const limiter = new SlidingWindowLimiter(reject);
    limiter.consume('a', 1, 1000, 0);
    rejection(() => limiter.consume('a', 1, 1000, 1));
    assert.doesNotThrow(() => limiter.consume('b', 1, 1000, 1));
  });

  it('evicts expired buckets at capacity, and returns 503 when all are live', () => {
    const limiter = new SlidingWindowLimiter(reject, 2);
    limiter.consume('a', 5, 1000, 0);
    limiter.consume('b', 5, 1000, 0);
    assert.equal(rejection(() => limiter.consume('c', 5, 1000, 500)).status, 503);
    // Both buckets have expired by t = 2000, so a new key is admitted.
    assert.doesNotThrow(() => limiter.consume('c', 5, 1000, 2000));
  });

  it('prunes each bucket with its own window during eviction', () => {
    const limiter = new SlidingWindowLimiter(reject, 2);
    limiter.consume('long', 1, 60_000, 0);
    limiter.consume('short', 1, 1000, 0);
    // A short-window call must not evict the still-active 60 s bucket.
    limiter.consume('new', 1, 1000, 5000);
    assert.equal(rejection(() => limiter.consume('long', 1, 60_000, 5001)).status, 429);
  });
});
