import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateSummary,
  generateSummaryAttempt,
  generateSummariesWithStats,
  generateTitleTranslations,
  isSummaryActiveFor,
  parseAnalysisResponse,
  summaryMaxConcurrency,
  summaryRateLimitKey,
  summaryRequestIntervalMs,
  summaryRequestsPerMinute,
  summaryTimeoutSeconds,
} from "@/lib/summarizer";
import { resetDistributedRateLimitForTests } from "@/lib/distributed-rate-limit";
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
  resetDistributedRateLimitForTests();
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
  for (const key of [
    "SUMMARY_PROVIDER",
    "SUMMARY_BASE_URL",
    "SUMMARY_API_KEY",
    "SUMMARY_MODEL",
    "SUMMARY_SKIP_PLATFORMS",
    "SUMMARY_MAX_INPUT_CHARS",
    "SUMMARY_MAX_CONCURRENCY",
    "SUMMARY_REQUESTS_PER_MINUTE",
    "SUMMARY_RATE_LIMIT_BACKEND",
    "SUMMARY_RATE_LIMIT_KEY",
    "SUMMARY_REQUEST_INTERVAL_MS",
    "SUMMARY_TIMEOUT_SECONDS",
    "SUMMARY_INPUT_COST_PER_1M_USD",
    "SUMMARY_OUTPUT_COST_PER_1M_USD",
    "DEEPSEEK_API_KEY",
    "ARK_API_KEY",
    "VOLCENGINE_API_KEY",
  ]) {
    delete process.env[key];
  }
});

describe("summarizer providers", () => {
  it("uses a stable shared rate-limit key and supports an explicit account scope", () => {
    expect(summaryRateLimitKey({ name: "openai-compatible", model: "step-3.5-flash" }))
      .toBe("summary:openai-compatible:step-3.5-flash");
    process.env.SUMMARY_RATE_LIMIT_KEY = "summary-account:primary";
    expect(summaryRateLimitKey({ name: "openai-compatible", model: "another-model" }))
      .toBe("summary-account:primary");
  });

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
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("deepseek-v4-flash");
    expect(body.response_format).toEqual({ type: "json_object" });
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

  it("uses StepFun 2603 low reasoning without a restrictive output cap", async () => {
    process.env.SUMMARY_PROVIDER = "openai_compatible";
    process.env.SUMMARY_BASE_URL = "https://api.stepfun.com/v1";
    process.env.SUMMARY_API_KEY = "step-key";
    process.env.SUMMARY_MODEL = "step-3.5-flash-2603";
    process.env.SUMMARY_SKIP_PLATFORMS = "";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "阶跃摘要" } }] }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(generateSummary(item())).resolves.toBe("阶跃摘要");

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.reasoning_effort).toBe("low");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("accepts OpenAI-compatible providers that return array content parts", async () => {
    process.env.SUMMARY_PROVIDER = "openai_compatible";
    process.env.SUMMARY_BASE_URL = "https://example.com/v1";
    process.env.SUMMARY_API_KEY = "custom-key";
    process.env.SUMMARY_MODEL = "compatible-model";
    process.env.SUMMARY_SKIP_PLATFORMS = "";
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: [{ type: "text", text: "数组内容摘要" }] } }] }), { status: 200 }),
    ) as typeof fetch;

    await expect(generateSummary(item())).resolves.toBe("数组内容摘要");
  });

  it("retries once without response_format when a compatible endpoint rejects JSON mode", async () => {
    process.env.SUMMARY_PROVIDER = "openai_compatible";
    process.env.SUMMARY_BASE_URL = "https://example.com/v1";
    process.env.SUMMARY_API_KEY = "custom-key";
    process.env.SUMMARY_MODEL = "compatible-model";
    process.env.SUMMARY_SKIP_PLATFORMS = "";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("response_format json_object is unsupported", { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "兼容接口摘要" }, finish_reason: "stop" }],
      }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(generateSummary(item())).resolves.toBe("兼容接口摘要");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toHaveProperty("response_format");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).not.toHaveProperty("response_format");
  });

  it("rejects responses cut off by the provider output limit", async () => {
    process.env.SUMMARY_PROVIDER = "openai_compatible";
    process.env.SUMMARY_BASE_URL = "https://example.com/v1";
    process.env.SUMMARY_API_KEY = "custom-key";
    process.env.SUMMARY_MODEL = "compatible-model";
    process.env.SUMMARY_SKIP_PLATFORMS = "";
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        message: { content: "{\"summary\":\"被截断的内容\"," },
        finish_reason: "length",
      }],
    }), { status: 200 })) as typeof fetch;

    await expect(generateSummaryAttempt(item())).resolves.toMatchObject({
      status: "failed",
      errorCode: "SUMMARY_OUTPUT_TRUNCATED",
    });
  });

  it("collects provider token usage in batch stats", async () => {
    process.env.SUMMARY_PROVIDER = "openai_compatible";
    process.env.SUMMARY_BASE_URL = "https://example.com/v1";
    process.env.SUMMARY_API_KEY = "custom-key";
    process.env.SUMMARY_MODEL = "compatible-model";
    process.env.SUMMARY_SKIP_PLATFORMS = "";
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "中文摘要" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 120, completion_tokens: 30 },
    }), { status: 200 })) as typeof fetch;

    const result = await generateSummariesWithStats([item()]);

    expect(result.stats).toMatchObject({ inputTokens: 120, outputTokens: 30 });
  });

  it("translates historical titles in one batched model request", async () => {
    process.env.SUMMARY_PROVIDER = "openai_compatible";
    process.env.SUMMARY_BASE_URL = "https://example.com/v1";
    process.env.SUMMARY_API_KEY = "custom-key";
    process.env.SUMMARY_MODEL = "compatible-model";
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        translations: [
          { id: "a", title_zh: "OpenAI 发布新模型" },
          { id: "b", title_zh: "智能体评测的新方法" },
        ],
      }) } }],
    }), { status: 200 })) as typeof fetch;

    const translated = await generateTitleTranslations([
      { id: "a", title: "OpenAI launches a new model" },
      { id: "b", title: "A new method for evaluating agents" },
    ]);

    expect(translated.get("a")).toBe("OpenAI 发布新模型");
    expect(translated.get("b")).toBe("智能体评测的新方法");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps a malformed title-translation batch isolated instead of failing the job", async () => {
    process.env.SUMMARY_PROVIDER = "openai_compatible";
    process.env.SUMMARY_BASE_URL = "https://example.com/v1";
    process.env.SUMMARY_API_KEY = "custom-key";
    process.env.SUMMARY_MODEL = "compatible-model";
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "{\"translations\":[{\"id\":\"a\"," } }],
    }), { status: 200 })) as typeof fetch;

    await expect(generateTitleTranslations([{ id: "a", title: "An English title" }]))
      .resolves.toEqual(new Map());
  });

  it("strips HTML and limits long model input while keeping the article tail", async () => {
    process.env.SUMMARY_PROVIDER = "openai_compatible";
    process.env.SUMMARY_BASE_URL = "https://example.com/v1";
    process.env.SUMMARY_API_KEY = "custom-key";
    process.env.SUMMARY_MODEL = "compatible-model";
    process.env.SUMMARY_SKIP_PLATFORMS = "";
    process.env.SUMMARY_MAX_INPUT_CHARS = "80";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "截断摘要" } }] }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(generateSummary({
      ...item(),
      contentHtml: `<article><script>bad()</script><p>${"开头".repeat(80)}</p><p>重要结论在末尾</p></article>`,
    })).resolves.toBe("截断摘要");

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const userContent = body.messages[1].content as string;
    expect(userContent).not.toContain("<article>");
    expect(userContent).not.toContain("bad()");
    expect(userContent).toContain("中间内容已按后台预算设置省略");
    expect(userContent).toContain("重要结论在末尾");
  });

  it("identifies X input so the model returns a faithful Chinese display translation", async () => {
    process.env.SUMMARY_PROVIDER = "openai_compatible";
    process.env.SUMMARY_BASE_URL = "https://example.com/v1";
    process.env.SUMMARY_API_KEY = "step-key";
    process.env.SUMMARY_MODEL = "step-3.5-flash-2603";
    process.env.SUMMARY_SKIP_PLATFORMS = "";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        translated_title: "OpenAI 今天发布了一项新功能。",
        summary: "OpenAI 宣布上线新功能。",
        content_type: "product_update",
        topic_tags: ["OpenAI", "产品动态"],
        keep_reason: "OpenAI 明确宣布新功能上线，提供了可核验的产品变化。",
        relevance_score: 80,
      }) } }],
    }), { status: 200 })) as typeof fetch;
    globalThis.fetch = fetchMock;

    const result = await generateSummaryAttempt({
      ...item(),
      platform: "x",
      upstreamId: "x-1",
      canonicalUrl: "https://x.com/openai/status/1",
      title: undefined,
      text: "OpenAI launched a new feature today.",
      contentHtml: undefined,
    });

    expect(result.translatedTitle).toBe("OpenAI 今天发布了一项新功能。");
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.messages[1].content).toContain("平台：x");
    expect(body.messages[0].content).toContain("忠实翻译正文");
  });

  it("keeps WeChat skipped by default until explicitly enabled", () => {
    process.env.SUMMARY_PROVIDER = "deepseek";
    expect(isSummaryActiveFor("wechat")).toBe(false);
    process.env.SUMMARY_SKIP_PLATFORMS = "";
    expect(isSummaryActiveFor("wechat")).toBe(true);
  });

  it("derives safe StepFun request pacing but lets explicit limits override it", () => {
    process.env.SUMMARY_BASE_URL = "https://api.stepfun.com/v1";
    expect(summaryRequestsPerMinute()).toBe(10);
    expect(summaryRequestIntervalMs()).toBe(6000);

    process.env.SUMMARY_REQUESTS_PER_MINUTE = "1000";
    expect(summaryRequestsPerMinute()).toBe(1000);
    expect(summaryRequestIntervalMs()).toBe(60);

    process.env.SUMMARY_MAX_CONCURRENCY = "5";
    expect(summaryMaxConcurrency()).toBe(5);
  });

  it("uses a 45 second model timeout by default and accepts an explicit override", () => {
    expect(summaryTimeoutSeconds()).toBe(45);
    process.env.SUMMARY_TIMEOUT_SECONDS = "75";
    expect(summaryTimeoutSeconds()).toBe(75);
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

  it("uses a clean local full-text fallback for WeChat when model output is unusable", async () => {
    process.env.SUMMARY_PROVIDER = "openai_compatible";
    process.env.SUMMARY_BASE_URL = "https://example.com/v1";
    process.env.SUMMARY_API_KEY = "custom-key";
    process.env.SUMMARY_MODEL = "compatible-model";
    process.env.SUMMARY_SKIP_PLATFORMS = "";
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "要1-2句中文，不重复标题，不用元表述。" } }] }), { status: 200 }),
    ) as typeof fetch;

    const result = await generateSummaryAttempt({
      ...item(),
      title: "GPT-5.6 用着是真爽，但这额度掉得也太狠了",
      text: "加我进AI讨论学习群",
      contentHtml:
        "<p>加我进AI讨论学习群，公众号右下角“联系方式” 文末有老金的开源知识库地址·全免费 到了 GPT-5.6，模型更主动，也更愿意把一件事一路做到底。</p><p>文章提醒用户明确任务终点，避免在大仓库中产生无效探索和额度浪费。</p>",
    });

    expect(result.status).toBe("success");
    expect(result.summary).toContain("任务终点");
    expect(result.summary).not.toContain("加我");
  });

  it("parses structured summary, content type and topic tags", () => {
    const parsed = parseAnalysisResponse(JSON.stringify({
      translated_title: "OpenAI 发布全新 Codex 产品能力",
      summary: "OpenAI 发布了新的 Codex 产品能力，强化了开发者工作流。",
      content_type: "product_update",
      topic_tags: ["OpenAI", "Codex", "Agent"],
      keep_reason: "明确说明 Codex 对开发者工作流的能力变化",
      relevance_score: 88,
    }));

    expect(parsed.summary).toContain("Codex");
    expect(parsed.translatedTitle).toBe("OpenAI 发布全新 Codex 产品能力");
    expect(parsed.contentType).toBe("product_update");
    expect(parsed.topicTags).toEqual(["OpenAI", "Codex", "Agent"]);
    expect(parsed.retentionReason).toBe("明确说明 Codex 对开发者工作流的能力变化");
    expect(parsed.relevanceScore).toBe(88);
  });

  it("extracts JSON even when a provider wraps it with extra text", () => {
    const parsed = parseAnalysisResponse(`好的，结果如下：
{"summary":"新基准用于评估 LLM Agent 的长期记忆操作能力。","content_type":"research","topic_tags":["LLM Agent","记忆","基准测试"]}
`);

    expect(parsed.summary).toContain("长期记忆");
    expect(parsed.contentType).toBe("research");
    expect(parsed.topicTags).toEqual(["LLM Agent", "记忆", "基准测试"]);
  });

  it("rejects prompt leakage instead of saving it as a summary", () => {
    const parsed = parseAnalysisResponse("我现在需要处理用户的请求，首先summary要1-2句中文，然后content_type是research，topic_tags要2-5个。");

    expect(parsed.summary).toBe("");
  });

  it("rejects leaked instruction fragments and non-summaries", () => {
    expect(parseAnalysisResponse("要1-2句中文，不重复标题，不用元表述。首先，这篇是arXiv上的论文。").summary).toBe("");
    expect(parseAnalysisResponse("{\"summary\":\"信息不足，暂无法形成可靠摘要。\"").summary).toBe("");
    expect(parseAnalysisResponse("信息不足，暂无法形成可靠摘要。").summary).toBe("");
    expect(parseAnalysisResponse("围绕DeepSeek招聘清单探讨AI时代所需人才的相关内容？").summary).toBe("");
    expect(parseAnalysisResponse("部分：要概括这个研究的内容，就是研究提出名为Pythia的多智能体系统。").summary).toBe("");
  });

  it("cleans conversational residue from otherwise valid summaries", () => {
    const parsed = parseAnalysisResponse(JSON.stringify({
      summary: "核心：Circle Internet（CRCL）获得美国货币监理署最终批准，这是其合规运营的重要里程碑。对，这个可以。",
      content_type: "industry_business",
      topic_tags: ["Circle", "OCC"],
    }));

    expect(parsed.summary).toBe("Circle Internet（CRCL）获得美国货币监理署最终批准，这是其合规运营的重要里程碑");
  });

  it("removes link-entry filler and fixes declarative question-mark residue", () => {
    expect(parseAnalysisResponse(JSON.stringify({
      summary: "这篇文章分析了企业部署 Agent 的成本与收益，还有讨论和链接入口？",
      content_type: "industry_business",
      topic_tags: ["Agent", "for", "1"],
    }))).toMatchObject({
      summary: "这篇文章分析了企业部署 Agent 的成本与收益",
      topicTags: ["Agent"],
    });

    expect(parseAnalysisResponse(JSON.stringify({
      summary: "新评测揭示了推理模型在长任务中的稳定性变化？",
      content_type: "research",
      topic_tags: ["推理模型"],
    })).summary).toBe("新评测揭示了推理模型在长任务中的稳定性变化。");
  });

  it("salvages the actual summary from verbose model reasoning", () => {
    const parsed = parseAnalysisResponse(
      "我现在需要处理用户的请求，首先summary可以写“新基准用于评估 LLM Agent 在长周期任务中的记忆能力，并区分不同记忆失败原因。”然后content_type是research。然后topic_tags的话，比如LLM Agent、记忆、基准测试。",
    );

    expect(parsed.summary).toBe("新基准用于评估 LLM Agent 在长周期任务中的记忆能力，并区分不同记忆失败原因。");
    expect(parsed.contentType).toBe("research");
    expect(parsed.topicTags).toEqual(["LLM", "Agent", "记忆", "基准测试"]);
  });

  it("keeps legacy plain-text provider output usable", () => {
    expect(parseAnalysisResponse("普通中文摘要")).toEqual({ summary: "普通中文摘要" });
  });
});
