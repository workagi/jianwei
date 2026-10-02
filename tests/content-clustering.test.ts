import { describe, expect, it } from "vitest";
import type { PlatformType } from "@/connectors/types";
import {
  buildFeaturedFeed,
  clusterReaderItems,
  compactEventMembers,
  groupPersistedEvents,
  eventTitleSimilarity,
  isLikelySameEvent,
  selectTopFeaturedEvents,
  type ClusterableReaderItem,
} from "@/lib/content-clustering";

function item(overrides: Partial<ClusterableReaderItem> = {}): ClusterableReaderItem {
  return {
    id: "one",
    platform: "trendradar" as PlatformType,
    source: "IT之家",
    title: "xAI 开源 Grok Build 编程智能体与终端界面",
    excerpt: "xAI 已经开源 Grok Build，开发者可以本地运行并进行自定义。",
    url: "https://example.com/one",
    tags: ["xAI", "Grok", "开源生态"],
    score: 76,
    whyKept: "Grok Build 从闭源产品变成可本地运行和定制的开发工具",
    date: "2026-07-16T05:07:00+08:00",
    ...overrides,
  };
}

describe("content event clustering", () => {
  it("detects near-identical cross-source event titles", () => {
    const left = item();
    const right = item({
      id: "two",
      platform: "x",
      source: "Elon Musk",
      title: "官宣：xAI 开源 Grok Build 编程 Agent 及终端界面",
      date: "2026-07-16T06:00:00+08:00",
    });
    expect(eventTitleSimilarity(left.title, right.title)).toBeGreaterThan(0.5);
    expect(isLikelySameEvent(left, right)).toBe(true);
    expect(eventTitleSimilarity(
      "Apple Intelligence approved for launch in China with Alibaba’s Qwen AI",
      "Apple Intelligence approved in China with Alibaba Qwen AI model",
    )).toBeGreaterThan(0.58);
  });

  it("does not merge generic shared tags when titles describe different events", () => {
    const left = item();
    const right = item({
      id: "two",
      platform: "wechat",
      source: "模型观察",
      title: "OpenAI 发布新的语音翻译模型",
      tags: ["AI", "模型发布"],
    });
    expect(isLikelySameEvent(left, right)).toBe(false);
  });
  it("does not infer temporal identity from missing or invalid dates", () => {
    expect(isLikelySameEvent(item({ date: "" }), item({ source: "Other", date: "" }))).toBe(false);
    expect(isLikelySameEvent(item({ date: "invalid" }), item({ source: "Other", date: "invalid" }))).toBe(false);
  });
  it("keeps the pair window from expanding through intermediate reports", () => {
    const clustered = clusterReaderItems([
      item({ id: "a", source: "A", date: "2026-09-26T00:00:00Z" }),
      item({ id: "b", source: "B", date: "2026-09-28T00:00:00Z" }),
      item({ id: "c", source: "C", date: "2026-09-30T00:00:00Z" }),
    ]);
    expect(clustered).toHaveLength(2);
  });

  it("keeps the strongest card and exposes the other source", () => {
    const clustered = clusterReaderItems([
      item({ score: 72 }),
      item({ id: "two", platform: "x", source: "xAI News", score: 84 }),
    ]);
    expect(clustered).toHaveLength(1);
    expect(clustered[0].source).toBe("xAI News");
    expect(clustered[0].relatedSources).toEqual([
      expect.objectContaining({ source: "IT之家" }),
    ]);
  });

  it("only selects sufficiently complete high-value content", () => {
    const featured = buildFeaturedFeed([
      item(),
      item({ id: "low", title: "低分内容", score: 42 }),
      item({ id: "empty", title: "没有摘要的内容", excerpt: "短", whyKept: "", score: 90 }),
      item({ id: "no-reason", title: "只有摘要没有具体推荐理由", excerpt: "这是一段足够长但没有模型推荐理由的摘要内容。", whyKept: "", score: 90 }),
    ]);
    expect(featured.map((entry) => entry.id)).toEqual(["one"]);
  });

  it("keeps the selected stream chronological while TOP ranking remains a separate decision", () => {
    const featured = buildFeaturedFeed([
      item({ id: "new-low", score: 60, date: "2026-07-16T08:00:00Z" }),
      item({ id: "old-high", score: 92, date: "2026-07-16T07:00:00Z" }),
    ]);
    expect(featured.map((entry) => entry.id)).toEqual(["new-low", "old-high"]);
    expect(selectTopFeaturedEvents(featured, { limit: 1, now: Date.parse("2026-07-16T08:30:00Z") })[0].id).toBe("old-high");
  });

  it("keeps one batch RSS source from dominating the featured feed", () => {
    const manyPapers = Array.from({ length: 12 }, (_, index) => item({
      id: `paper-${index}`,
      source: "arXiv cs.AI",
      title: `Agent Evaluation Research Number ${index}`,
      date: new Date(Date.parse("2026-07-16T04:00:00Z") - index * 60_000).toISOString(),
    }));
    const otherSources = Array.from({ length: 6 }, (_, index) => item({
      id: `news-${index}`,
      source: `News ${index}`,
      title: `Independent Product Update Number ${index}`,
      date: new Date(Date.parse("2026-07-15T04:00:00Z") - index * 60_000).toISOString(),
    }));
    const featured = buildFeaturedFeed([...manyPapers, ...otherSources], { maxItems: 10, balancePlatforms: true });
    expect(featured.filter((entry) => entry.source === "arXiv cs.AI")).toHaveLength(5);
    expect(featured.some((entry) => entry.source === "News 0")).toBe(true);
  });

  it("ranks value and freshness without treating additional coverage as proof", () => {
    const now = Date.parse("2026-07-16T08:00:00Z");
    const top = selectTopFeaturedEvents([
      item({ id: "single", source: "News A", score: 92, date: "2026-07-16T07:00:00Z" }),
      {
        ...item({ id: "corroborated", source: "News B", score: 86, date: "2026-07-16T06:00:00Z" }),
        relatedSources: [
          { platform: "x" as PlatformType, source: "X Source", title: "同一事件" },
          { platform: "wechat" as PlatformType, source: "公众号", title: "同一事件" },
        ],
      },
      item({ id: "same-source", source: "News A", score: 91, date: "2026-07-16T05:00:00Z" }),
      item({ id: "third", source: "News C", score: 72, date: "2026-07-16T04:00:00Z" }),
    ], { now });
    expect(top[0].id).toBe("single");
    expect(top.map((entry) => entry.source)).toEqual(["News A", "News B", "News C"]);
  });

  it("compacts batches without changing preferred representatives, source links or fallback dates", () => {
    const materials = Array.from({ length: 40 }, (_, index) => item({ id: `material-${index}`, eventId: "event",
      eventPreferredItemId: "material-2", source: `Source ${index % 3}`, score: 60 + index,
      date: new Date(Date.parse("2026-07-01T00:00:00Z") + index * 1000).toISOString(), url: `https://example.test/${index}` }));
    let compacted: ClusterableReaderItem[] = [];
    for (let offset = 0; offset < materials.length; offset += 7) compacted = compactEventMembers([...compacted, ...materials.slice(offset, offset + 7)]);
    expect(compacted.length).toBeLessThanOrEqual(5);
    expect(groupPersistedEvents(compacted)).toEqual(groupPersistedEvents(materials));
  });
});
