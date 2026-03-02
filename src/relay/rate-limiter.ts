/**
 * Token-bucket rate limiter, keyed by a string identifier (e.g. viewerId).
 */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; lastRefill: number }>();

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

  clear(): void {
    this.buckets.clear();
  }
}
