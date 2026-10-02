import { describe, expect, it } from "vitest";
import { BoundedFixedWindowLimiter } from "@/lib/bounded-fixed-window";

describe("BoundedFixedWindowLimiter", () => {
  it("enforces the fixed-window request limit", () => {
    const limiter = new BoundedFixedWindowLimiter(10);

    expect(limiter.allow("client-a", 2, 60_000, 1_000)).toBe(true);
    expect(limiter.allow("client-a", 2, 60_000, 1_001)).toBe(true);
    expect(limiter.allow("client-a", 2, 60_000, 1_002)).toBe(false);
    expect(limiter.allow("client-a", 2, 60_000, 61_000)).toBe(true);
  });

  it("never grows beyond its configured key capacity", () => {
    const limiter = new BoundedFixedWindowLimiter(3);

    expect(limiter.allow("client-a", 1, 60_000, 1_000)).toBe(true);
    expect(limiter.allow("client-b", 1, 60_000, 1_001)).toBe(true);
    expect(limiter.allow("client-c", 1, 60_000, 1_002)).toBe(true);
    expect(limiter.allow("client-d", 1, 60_000, 1_003)).toBe(true);

    expect(limiter.size()).toBe(3);
    // The oldest bucket was evicted, so a rotated key cannot grow the map.
    expect(limiter.allow("client-a", 1, 60_000, 1_004)).toBe(true);
    expect(limiter.size()).toBe(3);
  });

  it("removes expired buckets before evicting live clients", () => {
    const limiter = new BoundedFixedWindowLimiter(2);

    limiter.allow("expired", 1, 100, 0);
    limiter.allow("live", 1, 100, 150);
    limiter.allow("new", 1, 100, 151);

    expect(limiter.size()).toBe(2);
    expect(limiter.allow("live", 1, 100, 152)).toBe(false);
  });
});
