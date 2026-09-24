export type RateLimitResult = { allowed: boolean; retryAfterMs: number };

export class SlidingWindowRateLimiter {
  private hits = new Map<string, number[]>();

  take(key: string, limit: number, windowMs: number, now = Date.now()): RateLimitResult {
    const cutoff = now - windowMs;
    const recent = (this.hits.get(key) || []).filter(at => at > cutoff);
    if (recent.length >= limit) {
      this.hits.set(key, recent);
      return { allowed: false, retryAfterMs: Math.max(1, recent[0] + windowMs - now) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true, retryAfterMs: 0 };
  }
}
