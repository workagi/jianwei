import { describe, expect, it } from "vitest";
import { capRowsPerPlatformForUnifiedFeed, deriveMonitorHealth, formatReaderTime, groupReaderItemsByDate, monitorDetail, normalizeReaderPage, normalizeXDisplayText, readerDisplayTitle, readerRecommendationReason, rowPassesSourceQuality, trendRadarSourceKind, type ReaderItem } from "@/lib/reader-data";
import type { PlatformType } from "@/connectors/types";

describe("deriveMonitorHealth", () => {
  const base = {
    enabled: true,
    lastSuccessAt: null,
    failureCount: 0,
    lastError: null,
    healthStatus: "pending",
  };

  it("shows stale running jobs as interrupted", () => {
    const status = deriveMonitorHealth({
      ...base,
      latestRunStatus: "running",
      latestRunStartedAt: new Date(Date.now() - 11 * 60_000),
    });

    expect(status.health).toBe("采集中断");
    expect(status.warning).toBe(true);
    expect(status.statusDetail).toContain("可能是 worker 重启");
  });

  it("shows active running jobs as collecting", () => {
    const status = deriveMonitorHealth({
      ...base,
      latestRunStatus: "running",
      latestRunStartedAt: new Date(Date.now() - 2 * 60_000),
    });

    expect(status.health).toBe("采集中");
    expect(status.warning).toBe(false);
  });

  it("shows collected item count for healthy monitors", () => {
    const status = deriveMonitorHealth({
      ...base,
      lastSuccessAt: new Date(),
      itemCount: 25,
      latestRunStatus: "success",
      latestRunFetchedCount: 25,
    });

    expect(status.health).toBe("正常");
    expect(status.warning).toBe(false);
    expect(status.statusDetail).toBe("已采集 25 条");
  });

  it("keeps collection healthy when summary is rate limited", () => {
    const status = deriveMonitorHealth({
      ...base,
      lastSuccessAt: new Date(),
      itemCount: 25,
      latestRunStatus: "success",
      latestRunFetchedCount: 25,
      latestSummaryStatus: "rate_limited",
      latestSummaryAttemptedCount: 6,
      latestSummarySucceededCount: 0,
      latestSummaryErrorCode: "SUMMARY_RATE_LIMITED",
    });

    expect(status.health).toBe("正常");
    expect(status.warning).toBe(false);
    expect(status.statusDetail).toBe("已采集 25 条 · 摘要限流");
  });

  it("distinguishes first successful run with no content", () => {
    const status = deriveMonitorHealth({
      ...base,
      lastSuccessAt: new Date(),
      itemCount: 0,
      latestRunStatus: "success",
      latestRunFetchedCount: 0,
    });

    expect(status.health).toBe("首次无内容");
    expect(status.warning).toBe(true);
  });

  it("turns auth-like failures into an action-oriented authorization state", () => {
    const status = deriveMonitorHealth({
      ...base,
      platform: "wechat",
      latestRunStatus: "failed",
      latestRunErrorMessage: "WERSS_RESOLVE_FAILED:401",
    });

    expect(status.health).toBe("需要授权");
    expect(status.warning).toBe(true);
    expect(status.statusDetail).toContain("重新扫码");
  });

  it("surfaces stale WeRSS feeds without treating the monitor as misconfigured", () => {
    const status = deriveMonitorHealth({
      ...base,
      lastError: "WERSS_FEED_STALE:2026-07-19T10:00:00.000Z",
    });

    expect(status.health).toBe("公众号源停更");
    expect(status.warning).toBe(true);
    expect(status.statusDetail).toContain("等待上游恢复");
  });

  it("explains a disabled monitor without exposing the raw provider error", () => {
    const status = deriveMonitorHealth({
      ...base,
      enabled: false,
      lastError: "GATHER_TIMEOUT:wechat",
    });

    expect(status.health).toBe("已停用");
    expect(status.warning).toBe(true);
    expect(status.statusDetail).toContain("原因：采集超时");
    expect(status.statusDetail).not.toContain("GATHER_TIMEOUT:wechat");
  });
});

describe("monitorDetail", () => {
  it("marks TrendRadar as a system-managed source", () => {
    expect(monitorDetail("trendradar", 30)).toBe("系统内置 · 每 30 分钟");
  });

  it("keeps user-created monitors focused on collection cadence", () => {
    expect(monitorDetail("wechat", 60)).toBe("每 1 小时");
    expect(monitorDetail("wechat", 60, { kind: "keyword_rule", query: "AI Agent" })).toBe("公众号关键词 · 每 1 小时");
  });

  it("shows web search provider per monitor", () => {
    expect(monitorDetail("web_search", 30, { provider: "tavily" })).toBe("Tavily · 每 30 分钟");
    expect(monitorDetail("web_search", 30, {})).toBe("Brave · 每 30 分钟");
  });
});

describe("capRowsPerPlatformForUnifiedFeed", () => {
  it("prevents high-volume TrendRadar rows from drowning out other platforms", () => {
    const rows = [
      ...Array.from({ length: 30 }, (_, i) => ({
        id: `trend-${i}`,
        platform: "trendradar" as PlatformType,
        publishedAt: new Date(Date.UTC(2026, 6, 15, 1, 30 - i)),
      })),
      {
        id: "wechat-1",
        platform: "wechat" as PlatformType,
        publishedAt: new Date(Date.UTC(2026, 6, 14, 16, 0)),
      },
      {
        id: "web-1",
        platform: "web_search" as PlatformType,
        publishedAt: new Date(Date.UTC(2026, 6, 14, 15, 0)),
      },
    ];

    const capped = capRowsPerPlatformForUnifiedFeed(rows, 3);

    expect(capped.filter((row) => row.platform === "trendradar")).toHaveLength(3);
    expect(capped.some((row) => row.platform === "wechat")).toBe(true);
    expect(capped.some((row) => row.platform === "web_search")).toBe(true);
  });

  it("shows one document once even when multiple platforms discovered it", () => {
    const publishedAt = new Date(Date.UTC(2026, 6, 15, 1, 30));
    const capped = capRowsPerPlatformForUnifiedFeed([
      { id: "shared", platform: "web_search" as PlatformType, publishedAt },
      { id: "shared", platform: "trendradar" as PlatformType, publishedAt },
    ], 3);

    expect(capped).toHaveLength(1);
    expect(capped[0].id).toBe("shared");
  });
});

describe("normalizeReaderPage", () => {
  it("keeps positive integer pages and floors decimal input", () => {
    expect(normalizeReaderPage("3")).toBe(3);
    expect(normalizeReaderPage(2.9)).toBe(2);
  });

  it("falls back to the first page for invalid input", () => {
    expect(normalizeReaderPage(undefined)).toBe(1);
    expect(normalizeReaderPage("not-a-page")).toBe(1);
    expect(normalizeReaderPage(0)).toBe(1);
    expect(normalizeReaderPage(-4)).toBe(1);
  });
});

describe("readerDisplayTitle", () => {
  it("uses tweet content instead of an article-style missing-title label", () => {
    expect(readerDisplayTitle({ platform: "x", title: null, bodyText: "这是一条真实推文内容" })).toBe("这是一条真实推文内容");
  });

  it("prefers the model-translated Chinese tweet while preserving the source body", () => {
    expect(readerDisplayTitle({
      platform: "x",
      title: "旧标题",
      translatedTitle: "这是忠实翻译后的中文推文",
      bodyText: "This is the original English post",
    })).toBe("这是忠实翻译后的中文推文");
  });

  it("keeps explicit article titles and the non-X fallback", () => {
    expect(readerDisplayTitle({ platform: "wechat", title: "文章标题", bodyText: "正文" })).toBe("文章标题");
    expect(readerDisplayTitle({ platform: "wechat", title: null, bodyText: "正文" })).toBe("(无标题)");
  });

  it("prefers the model-generated Chinese title while preserving the source title in storage", () => {
    expect(readerDisplayTitle({
      platform: "trendradar",
      title: "OpenAI launches a new Codex feature",
      translatedTitle: "OpenAI 发布 Codex 新功能",
      bodyText: "正文",
    })).toBe("OpenAI 发布 Codex 新功能");
  });
});

describe("reader timeline presentation", () => {
  it("shows only hour and minute because the day is already grouped above", () => {
    expect(formatReaderTime(new Date("2026-07-16T05:10:00.000Z"))).toBe("13:10");
  });

  it("inserts a new Shanghai date heading when a feed crosses midnight", () => {
    const item = (id: string, date: string): ReaderItem => ({
      id,
      platform: "wechat",
      source: "测试公众号",
      sourceKind: "wechat",
      time: formatReaderTime(new Date(date)),
      date,
      title: id,
      excerpt: "",
      contentType: "opinion",
      contentTypeLabel: "观点解读",
      tags: [],
      score: 60,
      whyKept: "",
      match: "",
      bookmarked: false,
    });
    const groups = groupReaderItemsByDate([
      item("today", "2026-07-22T00:10:00.000Z"),
      item("yesterday", "2026-07-21T15:56:00.000Z"),
    ]);

    expect(groups.map((group) => group.key)).toEqual(["2026-07-22", "2026-07-21"]);
    expect(groups.map((group) => group.label)).toEqual(["7月22日", "7月21日"]);
    expect(groups.map((group) => group.items.map((entry) => entry.id))).toEqual([["today"], ["yesterday"]]);
  });

  it("removes invisible characters and excessive tweet whitespace without joining distinct lines", () => {
    expect(normalizeXDisplayText("  第一行\u200B   内容  \n\n   第二行\t内容  ")).toBe("第一行 内容\n第二行 内容");
  });

  it("only exposes concrete model-authored recommendation reasons", () => {
    expect(readerRecommendationReason({
      source: "model",
      reason: "公开了 Grok Build 的完整代码规模与仓库地址，可直接核对工程实现",
    })).toContain("Grok Build");
    expect(readerRecommendationReason({ source: "rules", reason: "包含可核对的产品动态信息" })).toBe("");
    expect(readerRecommendationReason({ source: "model", reason: "包含Agent相关的产品动态信息" })).toBe("");
  });
});

describe("rowPassesSourceQuality", () => {
  it("requires broad RSS feeds to match interests in the headline", () => {
    expect(rowPassesSourceQuality({
      platform: "trendradar",
      authorName: "Hacker News",
      title: "某品牌蓝牙耳机正式发布",
      bodyText: "文章正文顺带提到 AI 与开发者功能。",
    })).toBe(false);

    expect(rowPassesSourceQuality({
      platform: "trendradar",
      authorName: "Hacker News",
      title: "阿里发布新款 AI 智能体耳机",
      bodyText: "产品详情。",
    })).toBe(true);
  });

  it("hides existing rows when an RSS source is disabled", () => {
    expect(rowPassesSourceQuality({
      platform: "trendradar",
      authorName: "IT之家",
      title: "阿里发布新款 AI 智能体耳机",
      bodyText: "产品详情。",
    })).toBe(false);
  });

  it("keeps focused AI feeds eligible through their article excerpt", () => {
    expect(rowPassesSourceQuality({
      platform: "trendradar",
      authorName: "Simon Willison",
      title: "A practical new release",
      bodyText: "A detailed guide to using an open source LLM Agent.",
    })).toBe(true);
  });
});

describe("trendRadarSourceKind", () => {
  it("distinguishes real hotlists from built-in and custom RSS feeds", () => {
    expect(trendRadarSourceKind("百度热搜", "baidu")).toBe("hotlist");
    expect(trendRadarSourceKind("财联社热门", "cls-hot")).toBe("hotlist");
    expect(trendRadarSourceKind("arXiv cs.AI", "Researcher Name")).toBe("rss");
    expect(trendRadarSourceKind("The Decoder · AI News", "Author")).toBe("rss");
  });
});
