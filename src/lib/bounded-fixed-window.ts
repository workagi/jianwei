type FixedWindowBucket = {
  startedAt: number;
  count: number;
};

/**
 * Small process-local limiter for low-risk public endpoints.
 *
 * The map has a strict upper bound: untrusted clients cannot grow it without
 * limit by rotating address keys. When the bound is reached, expired buckets
 * are removed first and the oldest remaining bucket is evicted as a fallback.
 */
export class BoundedFixedWindowLimiter {
  private readonly buckets = new Map<string, FixedWindowBucket>();

  constructor(private readonly maxKeys = 10_000) {
    if (!Number.isInteger(maxKeys) || maxKeys < 1) {
      throw new Error("RATE_LIMIT_MAX_KEYS_INVALID");
    }
  }

  allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    if (!Number.isFinite(limit) || limit < 1 || !Number.isFinite(windowMs) || windowMs < 1) {
      throw new Error("RATE_LIMIT_CONFIGURATION_INVALID");
    }

    const current = this.buckets.get(key);
    if (current && now - current.startedAt < windowMs) {
      current.count += 1;
      return current.count <= limit;
    }

    if (current) this.buckets.delete(key);
    this.removeExpired(now, windowMs);
    while (this.buckets.size >= this.maxKeys) {
      const oldestKey = this.buckets.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.buckets.delete(oldestKey);
    }
    this.buckets.set(key, { startedAt: now, count: 1 });
    return true;
  }

  private removeExpired(now: number, windowMs: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.startedAt >= windowMs) this.buckets.delete(key);
    }
  }

  /** Visible for focused regression tests without exposing the bucket data. */
  size(): number {
    return this.buckets.size;
  }
}
