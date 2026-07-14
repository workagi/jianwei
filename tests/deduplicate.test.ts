import { describe, expect, it } from "vitest";
import { canonicalizeUrl, contentFingerprint, dedupeKey } from "@/ingestion/deduplicate";
import type { NormalizedItem } from "@/connectors/types";

const item: NormalizedItem = {
  platform: "x",
  upstreamId: "123",
  canonicalUrl: "https://example.com/story/?utm_source=x&b=2&a=1#top",
  title: "A story",
  text: "Useful text",
  authorHandle: "author",
  imageUrls: [],
  publishedAt: new Date("2026-07-08T08:00:00Z"),
  raw: {},
};

describe("deduplication", () => {
  it("removes tracking parameters and sorts the remainder", () => {
    expect(canonicalizeUrl(item.canonicalUrl)).toBe("https://example.com/story?a=1&b=2");
  });

  it("prefers the platform upstream id", () => {
    expect(dedupeKey(item)).toBe("x:id:123");
  });

  it("generates a stable content fingerprint", () => {
    expect(contentFingerprint(item)).toBe(contentFingerprint({ ...item, canonicalUrl: "https://other.example" }));
  });
});
