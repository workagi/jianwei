import { describe, expect, it } from "vitest";
import { buildContentPipelineView } from "@/lib/content-pipeline";

describe("buildContentPipelineView", () => {
  it("returns a useful empty state before the first collection", () => {
    const view = buildContentPipelineView([], {
      runs24h: 0,
      failedRuns24h: 0,
      partialRuns24h: 0,
      summaryAttempted24h: 0,
      summarySucceeded24h: 0,
      summaryFailed24h: 0,
      newItems24h: 0,
      lastRunAt: null,
    });

    expect(view.total).toBe(0);
    expect(view.platforms).toHaveLength(4);
    expect(view.attention[0]?.text).toContain("还没有内容");
  });

  it("calculates completion across all platforms", () => {
    const view = buildContentPipelineView([
      { platform: "wechat", total: 10, withSummary: 8, structured: 7, analysisReady: 6, analysisFailed: 1, withFullText: 9 },
      { platform: "trendradar", total: 30, withSummary: 27, structured: 24, analysisReady: 24, analysisFailed: 2, withFullText: 0 },
    ], {
      runs24h: 6,
      failedRuns24h: 0,
      partialRuns24h: 0,
      summaryAttempted24h: 20,
      summarySucceeded24h: 20,
      summaryFailed24h: 0,
      newItems24h: 14,
      lastRunAt: new Date("2026-07-15T02:00:00Z"),
    });

    expect(view.total).toBe(40);
    expect(view.withSummary).toBe(35);
    expect(view.summaryPercent).toBe(88);
    expect(view.analysisReady).toBe(30);
    expect(view.analysisFailed).toBe(3);
    expect(view.analysisPending).toBe(7);
    expect(view.analysisPercent).toBe(75);
    expect(view.wechatFullTextPercent).toBe(90);
    expect(view.platforms.find((row) => row.id === "trendradar")?.summaryPercent).toBe(90);
  });

  it("explains missing WeChat full text separately from missing summaries", () => {
    const view = buildContentPipelineView([
      { platform: "wechat", total: 12, withSummary: 5, structured: 8, withFullText: 7 },
    ], {
      runs24h: 2,
      failedRuns24h: 0,
      partialRuns24h: 0,
      summaryAttempted24h: 7,
      summarySucceeded24h: 5,
      summaryFailed24h: 2,
      newItems24h: 7,
      lastRunAt: new Date("2026-07-15T02:00:00Z"),
    });

    expect(view.wechatMissingFullText).toBe(5);
    expect(view.summaryMissing).toBe(7);
    expect(view.attention.some((item) => item.text.includes("5 篇公众号文章还没有抓到全文"))).toBe(true);
    expect(view.attention.some((item) => item.text.includes("7 条内容还没有模型摘要"))).toBe(true);
  });

  it("surfaces full text recovered by a fallback channel", () => {
    const view = buildContentPipelineView([
      {
        platform: "wechat",
        total: 10,
        withSummary: 7,
        structured: 7,
        withFullText: 8,
        fallbackFullText: 3,
        fullTextFailed: 2,
      },
    ], {
      runs24h: 1,
      failedRuns24h: 0,
      partialRuns24h: 0,
      summaryAttempted24h: 7,
      summarySucceeded24h: 7,
      summaryFailed24h: 0,
      newItems24h: 10,
      lastRunAt: new Date("2026-07-15T02:00:00Z"),
    });

    expect(view.wechatFallbackFullText).toBe(3);
    expect(view.wechatFullTextFailed).toBe(2);
    expect(view.platforms.find((row) => row.id === "wechat")?.fallbackFullText).toBe(3);
  });

  it("surfaces recent collection failures as the highest priority issue", () => {
    const view = buildContentPipelineView([
      { platform: "web_search", total: 10, withSummary: 10, structured: 10, withFullText: 0 },
    ], {
      runs24h: 5,
      failedRuns24h: 2,
      partialRuns24h: 1,
      summaryAttempted24h: 10,
      summarySucceeded24h: 10,
      summaryFailed24h: 0,
      newItems24h: 10,
      lastRunAt: new Date("2026-07-15T02:00:00Z"),
    });

    expect(view.attention[0]).toMatchObject({ tone: "danger" });
    expect(view.attention[0]?.text).toContain("2 次采集失败");
  });

  it("shows a healthy message when the pipeline has no backlog or failure", () => {
    const view = buildContentPipelineView([
      { platform: "x", total: 5, withSummary: 5, structured: 5, withFullText: 0 },
    ], {
      runs24h: 2,
      failedRuns24h: 0,
      partialRuns24h: 0,
      summaryAttempted24h: 5,
      summarySucceeded24h: 5,
      summaryFailed24h: 0,
      newItems24h: 5,
      lastRunAt: new Date("2026-07-15T02:00:00Z"),
    });

    expect(view.attention).toEqual([
      expect.objectContaining({ tone: "ok", text: expect.stringContaining("没有明显积压") }),
    ]);
  });

  it("normalizes database timestamp strings before the server component formats them", () => {
    const recent = {
      runs24h: 1,
      failedRuns24h: 0,
      partialRuns24h: 0,
      summaryAttempted24h: 0,
      summarySucceeded24h: 0,
      summaryFailed24h: 0,
      newItems24h: 0,
      lastRunAt: "2026-07-15T02:00:00.000Z",
    };
    const view = buildContentPipelineView([], recent as unknown as Parameters<typeof buildContentPipelineView>[1]);

    expect(view.recent.lastRunAt).toBeInstanceOf(Date);
    expect(view.recent.lastRunAt?.toISOString()).toBe("2026-07-15T02:00:00.000Z");
  });
});
