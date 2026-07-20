import { describe, expect, it } from "vitest";
import { CURATED_RSS_SOURCES } from "@/lib/trendradar-source-library";

describe("curated TrendRadar RSS source library", () => {
  it("uses unique stable identifiers and valid public feed URLs", () => {
    const ids = CURATED_RSS_SOURCES.map((source) => source.id);
    const urls = CURATED_RSS_SOURCES.map((source) => source.url.replace(/\/$/, ""));

    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(urls).size).toBe(urls.length);
    for (const source of CURATED_RSS_SOURCES) {
      expect(new URL(source.url).protocol).toBe("https:");
      expect(source.description.length).toBeGreaterThan(8);
    }
  });

  it("covers official, media and technical-author sources", () => {
    const categories = new Set(CURATED_RSS_SOURCES.map((source) => source.category));
    expect(categories).toEqual(new Set(["官方动态", "专业媒体", "技术作者"]));
  });
});
