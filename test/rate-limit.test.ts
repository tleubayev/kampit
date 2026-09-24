import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlidingWindowRateLimiter } from '../src/rate-limit.ts';

test('rate limiter blocks excess requests and reports when the window reopens', () => {
  const limiter = new SlidingWindowRateLimiter();
  assert.equal(limiter.take('user-1', 3, 60_000, 1_000).allowed, true);
  assert.equal(limiter.take('user-1', 3, 60_000, 2_000).allowed, true);
  assert.equal(limiter.take('user-1', 3, 60_000, 3_000).allowed, true);
  const blocked = limiter.take('user-1', 3, 60_000, 4_000);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterMs, 57_000);
  assert.equal(limiter.take('other-user', 3, 60_000, 4_000).allowed, true);
  assert.equal(limiter.take('user-1', 3, 60_000, 61_001).allowed, true);
});
