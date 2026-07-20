import { describe, expect, it } from "vitest";
import { TrendRadarConnector } from "@/connectors/trendradar/trendradar-connector";

describe("TrendRadarConnector", () => {
  it("normalizes hotlist and RSS results", async () => {
    const client = {
      callTool: async (name: string) => name === "get_latest_news" ? {
        success: true,
        data: [{ title: "AI 新模型发布", platform: "zhihu", platform_name: "知乎", rank: 1, timestamp: "2026-07-08 10:00:00", url: "https://example.com/news" }],
      } : {
        success: true,
        data: [{ title: "AI RSS 文章", feed_id: "hn", feed_name: "Hacker News", url: "https://example.com/rss", published_at: "2026-07-08T09:00:00Z", author: "Alice", date: "2026-07-08", fetch_time: "2026-07-08 10:00:00", summary: "AI 摘要" }],
      },
    };
    const connector = new TrendRadarConnector(client as never);
    const news = await connector.latestNews();
    const rss = await connector.latestRss();
    expect(news[0]).toMatchObject({ platform: "trendradar", authorName: "知乎", title: "AI 新模型发布" });
    expect(news[0].publishedAt.toISOString()).toBe("2026-07-08T02:00:00.000Z");
    expect(rss[0]).toMatchObject({ platform: "trendradar", authorName: "Hacker News", text: "AI 摘要" });
    expect(rss[0].publishedAt.toISOString()).toBe("2026-07-08T09:00:00.000Z");
  });

  it("filters unrelated raw hotlist noise before importing", async () => {
    const client = {
      callTool: async () => ({
        success: true,
        data: [
          { title: "AI Agent 开发工具发布", platform: "zhihu", platform_name: "知乎", rank: 1, timestamp: "2026-07-08 10:00:00", url: "https://example.com/ai" },
          { title: "明星综艺热搜", platform: "weibo", platform_name: "微博", rank: 2, timestamp: "2026-07-08 10:01:00", url: "https://example.com/ent" },
        ],
      }),
    };

    const connector = new TrendRadarConnector(client as never);
    const news = await connector.latestNews();

    expect(news).toHaveLength(1);
    expect(news[0].title).toBe("AI Agent 开发工具发布");
  });
});
