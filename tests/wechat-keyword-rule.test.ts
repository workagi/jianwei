import { describe, expect, it } from "vitest";
import { matchesWechatKeywordRule } from "@/connectors/wechat/keyword-rule";
import type { items } from "@/db/schema";
import type { WechatKeywordMonitorConfig } from "@/connectors/types";

type ItemRow = typeof items.$inferSelect;

const baseConfig: WechatKeywordMonitorConfig = {
  kind: "keyword_rule",
  query: "AI Agent",
  requiredTerms: ["AI Agent", "智能体"],
  excludedTerms: [],
  matchMode: "any",
  sourceMonitorIds: [],
  fields: ["title", "summary", "content"],
};

function row(overrides: Partial<ItemRow> = {}): ItemRow {
  return {
    id: "item-1",
    platform: "wechat",
    upstreamId: "wx-1",
    canonicalUrl: "https://mp.weixin.qq.com/s/a",
    authorId: "mp-1",
    authorName: "赛博禅心",
    authorHandle: null,
    title: "AI Agent 工作流实践",
    bodyText: "这是一篇关于智能体和自动化的文章",
    aiSummary: null,
    contentHtml: null,
    imageUrls: [],
    publishedAt: new Date("2026-07-14T00:00:00Z"),
    fetchedAt: new Date("2026-07-14T00:00:00Z"),
    contentHash: "hash",
    createdAt: new Date("2026-07-14T00:00:00Z"),
    updatedAt: new Date("2026-07-14T00:00:00Z"),
    ...overrides,
  };
}

describe("matchesWechatKeywordRule", () => {
  it("matches any configured term by default", () => {
    expect(matchesWechatKeywordRule(row(), baseConfig)).toBe(true);
  });

  it("requires every term in all mode", () => {
    expect(matchesWechatKeywordRule(row({ title: "AI Agent 工作流实践", bodyText: "自动化文章" }), {
      ...baseConfig,
      matchMode: "all",
    })).toBe(false);
    expect(matchesWechatKeywordRule(row(), { ...baseConfig, matchMode: "all" })).toBe(true);
  });

  it("drops rows containing excluded terms", () => {
    expect(matchesWechatKeywordRule(row({ bodyText: "AI Agent 课程广告" }), {
      ...baseConfig,
      excludedTerms: ["广告"],
    })).toBe(false);
  });
});
