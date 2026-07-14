import { describe, expect, it } from "vitest";
import type { NormalizedItem, WebSearchMonitorConfig } from "@/connectors/types";
import { filterSearchItems } from "@/connectors/web/result-filter";

const baseConfig: WebSearchMonitorConfig = {
  provider: "tavily",
  query: "momenta",
  resultType: "news",
  exactPhrases: [],
  excludedTerms: [],
  includeDomains: [],
  excludeDomains: [],
};

function item(overrides: Partial<NormalizedItem>): NormalizedItem {
  return {
    platform: "web_search",
    upstreamId: overrides.canonicalUrl ?? "https://example.com/a",
    canonicalUrl: "https://example.com/a",
    title: "Momenta raises funding",
    text: "Autonomous driving company update",
    imageUrls: [],
    publishedAt: new Date("2026-07-14T00:00:00Z"),
    raw: {},
    ...overrides,
  };
}

describe("filterSearchItems", () => {
  it("drops semantic noise with excluded terms and domains", () => {
    const { items, dropped } = filterSearchItems(
      [
        item({ canonicalUrl: "https://auto.example.com/momenta", title: "Momenta IPO update" }),
        item({ canonicalUrl: "https://nasa.gov/asteroid", title: "NASA studies asteroid momenta", text: "physics" }),
      ],
      {
        ...baseConfig,
        excludedTerms: ["physics", "NASA"],
        excludeDomains: ["nasa.gov"],
      },
    );

    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Momenta IPO update");
    expect(dropped).toBe(1);
  });

  it("requires every configured exact phrase before keeping an item", () => {
    const { items } = filterSearchItems(
      [
        item({ title: "Momenta autonomous driving update", text: "Robotaxi test" }),
        item({ title: "Momenta financial results", text: "Company update" }),
      ],
      {
        ...baseConfig,
        exactPhrases: ["Momenta", "autonomous driving"],
      },
    );

    expect(items).toHaveLength(1);
    expect(items[0].title).toContain("autonomous driving");
  });

  it("honors include domains as an allowlist", () => {
    const { items } = filterSearchItems(
      [
        item({ canonicalUrl: "https://example.com/news", title: "Momenta news" }),
        item({ canonicalUrl: "https://spam.com/news", title: "Momenta news" }),
      ],
      {
        ...baseConfig,
        includeDomains: ["example.com"],
      },
    );

    expect(items.map((row) => row.canonicalUrl)).toEqual(["https://example.com/news"]);
  });
});
