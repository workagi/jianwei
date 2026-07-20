import { describe, expect, it } from "vitest";
import { resolveSourceProviderId, SOURCE_PROVIDER_DESCRIPTORS } from "@/sources/registry";

describe("source provider registry", () => {
  it.each([
    ["x", {}, "x_official"],
    ["x", { provider: "x_grok" }, "x_grok"],
    ["wechat", { kind: "account", articleUrl: "https://mp.weixin.qq.com/s/a" }, "wechat_werss"],
    ["wechat", { kind: "keyword_rule", query: "AI Agent" }, "wechat_keyword"],
    ["web_search", { provider: "brave", query: "AI" }, "web_brave"],
    ["web_search", { provider: "tavily", query: "AI" }, "web_tavily"],
    ["web_search", { provider: "serper", query: "AI" }, "web_serper"],
    ["trendradar", {}, "trendradar"],
  ] as const)("maps %s config to %s", (platform, config, expected) => {
    expect(resolveSourceProviderId(platform, config)).toBe(expected);
  });

  it("keeps provider descriptors unique and product-readable", () => {
    const ids = SOURCE_PROVIDER_DESCRIPTORS.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(SOURCE_PROVIDER_DESCRIPTORS.every((provider) => provider.label.length > 0)).toBe(true);
  });

  it("rejects an unknown platform instead of silently choosing a collector", () => {
    expect(() => resolveSourceProviderId("unknown" as never, {})).toThrow("UNKNOWN_SOURCE_PROVIDER");
  });
});
