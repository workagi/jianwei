import { describe, expect, it } from "vitest";
import { capRowsPerPlatformForUnifiedFeed, deriveMonitorHealth, monitorDetail } from "@/lib/reader-data";
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
      latestRunStatus: "failed",
      latestRunErrorMessage: "WERSS_RESOLVE_FAILED:401",
    });

    expect(status.health).toBe("需要授权");
    expect(status.warning).toBe(true);
    expect(status.statusDetail).toContain("检查平台密钥");
  });

  it("shows the last error when a failed monitor has been auto-disabled", () => {
    const status = deriveMonitorHealth({
      ...base,
      enabled: false,
      lastError: "GATHER_TIMEOUT:wechat",
    });

    expect(status.health).toBe("已停用");
    expect(status.warning).toBe(true);
    expect(status.statusDetail).toContain("GATHER_TIMEOUT:wechat");
  });
});

describe("monitorDetail", () => {
  it("marks TrendRadar as a system-managed source", () => {
    expect(monitorDetail("trendradar", 30)).toBe("系统内置 · 每 30 分钟");
  });

  it("keeps user-created monitors focused on collection cadence", () => {
    expect(monitorDetail("wechat", 60)).toBe("每 60 分钟");
    expect(monitorDetail("wechat", 60, { kind: "keyword_rule", query: "AI Agent" })).toBe("公众号关键词 · 每 60 分钟");
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
});
