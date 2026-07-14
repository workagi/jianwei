import { afterEach, describe, expect, it, vi } from "vitest";
import { generateSummary, generateSummaryAttempt, isSummaryActiveFor, parseAnalysisResponse } from "@/lib/summarizer";
import type { NormalizedItem } from "@/connectors/types";

const ORIGINAL_FETCH = globalThis.fetch;

function item(): NormalizedItem {
  return {
    platform: "wechat",
    upstreamId: "wx-1",
    canonicalUrl: "https://mp.weixin.qq.com/s/demo",
    title: "测试标题",
    text: "这是一段公众号文章正文。",
    contentHtml: "<p>这是一段公众号文章正文。</p>",
    imageUrls: [],
    publishedAt: new Date("2026-07-14T08:00:00Z"),
    raw: {},
  };
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
    "DEEPSEEK_API_KEY",
    "ARK_API_KEY",
    "VOLCENGINE_API_KEY",
  ]) {
    delete process.env[key];
  }
});

describe("summarizer providers", () => {
  it("uses DeepSeek preset through OpenAI-compatible chat completions", async () => {
    process.env.SUMMARY_PROVIDER = "deepseek";
    process.env.SUMMARY_API_KEY = "ds-key";
    process.env.SUMMARY_SKIP_PLATFORMS = "";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "中文摘要" } }] }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const summary = await generateSummary(item());

    expect(summary).toBe("中文摘要");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.deepseek.com/chat/completions");
    expect(JSON.parse(String(init?.body)).model).toBe("deepseek-v4-flash");
  });

  it("uses Volcengine Ark default base URL and requires caller-provided model", async () => {
    process.env.SUMMARY_PROVIDER = "volcengine";
    process.env.SUMMARY_API_KEY = "ark-key";
    process.env.SUMMARY_MODEL = "ep-demo";
    process.env.SUMMARY_SKIP_PLATFORMS = "";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "方舟摘要" } }] }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const summary = await generateSummary(item());

    expect(summary).toBe("方舟摘要");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://ark.cn-beijing.volces.com/api/v3/chat/completions");
    expect(JSON.parse(String(init?.body)).model).toBe("ep-demo");
  });

  it("uses custom OpenAI-compatible base URL without duplicating chat/completions", async () => {
    process.env.SUMMARY_PROVIDER = "openai_compatible";
    process.env.SUMMARY_BASE_URL = "https://example.com/v1/chat/completions";
    process.env.SUMMARY_API_KEY = "custom-key";
    process.env.SUMMARY_MODEL = "qwen-plus";
    process.env.SUMMARY_SKIP_PLATFORMS = "";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "自定义摘要" } }] }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const summary = await generateSummary(item());

    expect(summary).toBe("自定义摘要");
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://example.com/v1/chat/completions");
  });

  it("keeps WeChat skipped by default until explicitly enabled", () => {
    process.env.SUMMARY_PROVIDER = "deepseek";
    expect(isSummaryActiveFor("wechat")).toBe(false);
    process.env.SUMMARY_SKIP_PLATFORMS = "";
    expect(isSummaryActiveFor("wechat")).toBe(true);
  });

  it("classifies provider 429 as summary rate limiting without throwing", async () => {
    process.env.SUMMARY_PROVIDER = "deepseek";
    process.env.SUMMARY_API_KEY = "ds-key";
    process.env.SUMMARY_SKIP_PLATFORMS = "";
    globalThis.fetch = vi.fn(async () => new Response("too many requests", { status: 429 })) as typeof fetch;

    const result = await generateSummaryAttempt(item());

    expect(result.status).toBe("rate_limited");
    expect(result.errorCode).toBe("SUMMARY_RATE_LIMITED");
  });

  it("parses structured summary, content type and topic tags", () => {
    const parsed = parseAnalysisResponse(JSON.stringify({
      summary: "OpenAI 发布了新的 Codex 产品能力，强化了开发者工作流。",
      content_type: "product_update",
      topic_tags: ["OpenAI", "Codex", "Agent"],
    }));

    expect(parsed.summary).toContain("Codex");
    expect(parsed.contentType).toBe("product_update");
    expect(parsed.topicTags).toEqual(["OpenAI", "Codex", "Agent"]);
  });

  it("keeps legacy plain-text provider output usable", () => {
    expect(parseAnalysisResponse("普通中文摘要")).toEqual({ summary: "普通中文摘要" });
  });
});
