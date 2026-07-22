import { afterEach, describe, expect, it, vi } from "vitest";
import type { NormalizedItem } from "@/connectors/types";
import {
  ingest,
  type IngestItemRow,
  type IngestMatchLink,
  type IngestRepository,
  type IngestSourceObservation,
} from "@/ingestion/ingest-items";

const ORIGINAL_FETCH = globalThis.fetch;

class WorkflowRepository implements IngestRepository {
  rows: IngestItemRow[] = [];
  links: IngestMatchLink[] = [];
  sources: IngestSourceObservation[] = [];

  async upsertItems(rows: IngestItemRow[]) {
    this.rows.push(...rows);
    return rows.map((row, index) => ({
      id: `workflow-${index}`,
      platform: row.platform as NormalizedItem["platform"],
      upstreamId: row.upstreamId,
      canonicalUrl: row.canonicalUrl,
    }));
  }

  async upsertSourceItems(observations: IngestSourceObservation[]) {
    this.sources.push(...observations);
    return observations.map((observation, index) => ({
      id: `workflow-source-${index}`,
      itemId: observation.itemId,
      platform: observation.platform,
      sourceProvider: observation.sourceProvider,
      upstreamId: observation.upstreamId,
    }));
  }

  async linkMatches(links: IngestMatchLink[]) {
    this.links.push(...links);
    return links.length;
  }
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
  for (const key of [
    "SUMMARY_PROVIDER",
    "SUMMARY_BASE_URL",
    "SUMMARY_API_KEY",
    "SUMMARY_MODEL",
    "SUMMARY_SKIP_PLATFORMS",
    "SUMMARY_REQUESTS_PER_MINUTE",
    "SUMMARY_REQUEST_INTERVAL_MS",
  ]) {
    delete process.env[key];
  }
});

describe("lightweight model workflow simulation", () => {
  it("routes X, WeChat and RSS from collection through durable reader fields", async () => {
    process.env.SUMMARY_PROVIDER = "openai_compatible";
    process.env.SUMMARY_BASE_URL = "https://lightweight-model.invalid/v1";
    process.env.SUMMARY_API_KEY = "test-only";
    process.env.SUMMARY_MODEL = "lightweight-simulator";
    process.env.SUMMARY_SKIP_PLATFORMS = "";

    globalThis.fetch = vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as {
        messages: Array<{ content: string }>;
      };
      const content = request.messages[1]?.content ?? "";
      const isX = content.includes("平台：x");
      const isWechat = content.includes("平台：wechat");
      const payload = {
        translated_title: isX
          ? "OpenAI 发布轻量模型的新能力。"
          : isWechat
            ? "公众号全文理解实践"
            : "AI 智能体工具发布",
        summary: isWechat
          ? "文章说明了如何用完整正文生成可靠摘要，并避免把引流话术当作内容重点。"
          : isX
            ? "OpenAI 公布轻量模型的新能力和上线时间。"
            : "新工具为开发者提供可复用的 AI 智能体工作流。",
        content_type: isWechat ? "tutorial" : "product_update",
        topic_tags: isWechat ? ["公众号", "摘要"] : ["AI", "Agent"],
        keep_reason: isWechat
          ? "文章给出公众号全文清洗与摘要生成的具体流程，可直接用于内容采集链路。"
          : "内容明确给出新能力、适用对象和上线动作，具备可核验的产品信息增量。",
        relevance_score: isWechat ? 84 : 82,
      };
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 40 },
      }), { status: 200 });
    }) as typeof fetch;

    const now = new Date("2026-07-18T08:00:00Z");
    const input: NormalizedItem[] = [
      {
        platform: "x",
        upstreamId: "x-1",
        canonicalUrl: "https://x.com/openai/status/1",
        authorName: "OpenAI",
        authorHandle: "OpenAI",
        text: "OpenAI launched a new lightweight model capability today.",
        imageUrls: [],
        publishedAt: now,
        raw: {},
      },
      {
        platform: "wechat",
        upstreamId: "wx-1",
        canonicalUrl: "https://mp.weixin.qq.com/s/workflow",
        authorName: "测试公众号",
        title: "公众号全文理解实践",
        text: "文章摘要片段",
        contentHtml: "<article><p>文章介绍正文清洗、摘要生成和质量校验的完整流程。</p></article>",
        imageUrls: [],
        publishedAt: now,
        raw: {},
      },
      {
        platform: "trendradar",
        upstreamId: "rss-1",
        canonicalUrl: "https://example.com/ai-agent",
        authorName: "Hacker News",
        title: "AI Agent workflow tool launches",
        text: "A new workflow tool for AI agent developers.",
        imageUrls: [],
        publishedAt: now,
        raw: {},
      },
    ];
    const repo = new WorkflowRepository();

    const result = await ingest(repo, { items: input, monitorId: "workflow-monitor" });

    expect(result).toMatchObject({
      itemsUpserted: 3,
      matchesInserted: 3,
      summary: {
        status: "success",
        attempted: 3,
        succeeded: 3,
        failed: 0,
        inputTokens: 300,
        outputTokens: 120,
      },
    });
    expect(repo.rows).toHaveLength(3);
    expect(repo.rows.every((row) => row.analysisStatus === "success")).toBe(true);
    // retentionSource / retentionReason moved to item_matches (repo.links)
    expect(repo.links.length).toBeGreaterThanOrEqual(3);
    // Model outcomes flow through summary backfill -> item_matches; links keep
    // informationValueScore from the document row as the base relevance signal.
    expect(repo.links.every((link) => (link.relevanceScore ?? 0) >= 50)).toBe(true);
    expect(repo.rows.find((row) => row.platform === "x")?.translatedTitle).toContain("新能力");
    expect(repo.rows.some((row) => /content_type|topic_tags|我现在需要处理/i.test(row.aiSummary ?? ""))).toBe(false);
  });
});
