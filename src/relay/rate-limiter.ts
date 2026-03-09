/**
 * Token-bucket rate limiter, keyed by a string identifier (e.g. viewerId).
 */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; lastRefill: number }>();
  private lastEviction = 0;
  private static readonly EVICT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
  private static readonly STALE_MS = 60 * 60 * 1000; // 1 hour

  constructor(
    private maxTokens: number,
    private refillRate: number, // tokens per second
  ) {}

  /**
   * Returns true if the action is allowed (one token consumed),
   * false if the rate limit is exceeded.
   */
  allow(key: string): boolean {
    const now = Date.now();

    // Periodic stale bucket cleanup
    if (now - this.lastEviction > RateLimiter.EVICT_INTERVAL_MS) {
      this.lastEviction = now;
      this.evictStale(now);
    }

    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = { tokens: this.maxTokens, lastRefill: now };
      this.buckets.set(key, bucket);
    }

    // Refill tokens based on elapsed time
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(this.maxTokens, bucket.tokens + elapsed * this.refillRate);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }

    return false;
  }

  removeKey(key: string): void {
    this.buckets.delete(key);
  }

  clear(): void {
    this.buckets.clear();
  }

  private evictStale(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill > RateLimiter.STALE_MS) {
        this.buckets.delete(key);
      }
    }
  }
}
