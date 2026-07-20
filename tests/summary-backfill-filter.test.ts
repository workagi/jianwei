import { describe, expect, it, vi } from "vitest";
import { resolveBackfillScope, shouldProcessModelBackfill } from "@/lib/summary-backfill";

describe("backfill scope resolution", () => {
  it("maps failuresOnly to failures and defaults manual calls to incomplete", () => {
    expect(resolveBackfillScope({ failuresOnly: true })).toBe("failures");
    expect(resolveBackfillScope({ scope: "missing_summary" })).toBe("missing_summary");
    expect(resolveBackfillScope({})).toBe("incomplete");
  });
});

describe("model backfill reader gate", () => {
  it("never applies TrendRadar reader rules to other platforms", () => {
    const gate = vi.fn(() => false);
    expect(shouldProcessModelBackfill({
      platform: "wechat",
      title: "公众号文章",
      bodyText: "正文",
      authorName: null,
    }, gate)).toBe(true);
    expect(gate).not.toHaveBeenCalled();
  });

  it("blocks TrendRadar rows the reader would hide before model processing", () => {
    const gate = vi.fn(() => false);
    expect(shouldProcessModelBackfill({
      platform: "trendradar",
      title: "某品牌蓝牙耳机正式发布",
      bodyText: "正文顺带提到 AI",
      authorName: "Hacker News",
    }, gate)).toBe(false);
    expect(gate).toHaveBeenCalledWith({
      title: "某品牌蓝牙耳机正式发布",
      text: "正文顺带提到 AI",
      authorName: "Hacker News",
    });
  });

  it("keeps TrendRadar rows the reader would show", () => {
    expect(shouldProcessModelBackfill({
      platform: "trendradar",
      title: "OpenAI 发布新模型",
      bodyText: "模型更新详情",
      authorName: "知乎",
    }, () => true)).toBe(true);
  });
});
