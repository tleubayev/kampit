export type RateLimitResult = { allowed: boolean; retryAfterMs: number };

export class SlidingWindowRateLimiter {
  private hits = new Map<string, number[]>();
  private operations = 0;

  take(key: string, limit: number, windowMs: number, now = Date.now()): RateLimitResult {
    if (++this.operations % 256 === 0) this.prune(now, windowMs);
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

  private prune(now: number, windowMs: number) {
    const cutoff = now - windowMs;
    for (const [key, values] of this.hits) {
      const recent = values.filter(at => at > cutoff);
      if (recent.length) this.hits.set(key, recent); else this.hits.delete(key);
    }
  }
}
