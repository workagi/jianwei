/**
 * 模型 API 内容理解（摘要 + 内容类型 + 主题标签）。
 *
 * 通过后台「模型 API」面板驱动，无需改任何文件：
 *   - 面板保存 provider、OpenAI-compatible Base URL、模型名与 API Key 到 api_credentials 表；
 *   - worker 每轮把 SUMMARY_PROVIDER / SUMMARY_BASE_URL / SUMMARY_API_KEY / SUMMARY_SKIP_PLATFORMS
 *     等刷新进 process.env（见 worker/index.ts 的 refreshCredentials）；
 *   - 本模块按 process.env 实时读取，保存后下一轮采集即生效。
 *
 * 默认 SUMMARY_PROVIDER 未配置（或选「关闭」），generateSummaryAttempt 直接返回 disabled，
 * 采集链路行为完全不变（前端回退显示微信/来源自带引子 body_text）。
 *
 * provider 支持通用 OpenAI-compatible（DeepSeek / 火山方舟 / OpenAI / 自定义等）
 * 与 Claude 直连 HTTPS API，无需额外安装 SDK；
 * 在后台「模型 API」填写并保存后即对【新文章】自动生成摘要、内容类型和主题标签。
 * 微信公众号需 werss-connector 抓取全文并填入 NormalizedItem.contentHtml（见 isSummaryActiveFor 守卫）。
 *
 * 调用方（ingest）已保证：仅对「新条目」生成、异常/超时一律兜底为 null，
 * 因此无论是否启用、无论 provider 是否实现完整，都不会中断采集或覆盖已有摘要。
 */
import type { NormalizedItem } from "@/connectors/types";
import { normalizeContentType, normalizeTopicTags, type ContentTypeId } from "@/lib/item-tags";

export interface SummaryInput {
  platform: string;
  title?: string | null;
  text: string;
  contentHtml?: string | null;
  canonicalUrl?: string | null;
  authorName?: string | null;
}

export interface SummaryProvider {
  name: string;
  /** 返回中文 1–2 句内容摘要；失败抛错由调用方兜底为 null。signal 用于超时中断。 */
  generate(input: SummaryInput, signal?: AbortSignal): Promise<string>;
}

export type SummaryAttemptStatus = "success" | "skipped" | "disabled" | "failed" | "rate_limited" | "timeout";

export interface SummaryAttemptResult {
  status: SummaryAttemptStatus;
  summary?: string;
  contentType?: ContentTypeId;
  topicTags?: string[];
  provider?: string;
  errorCode?: string;
  errorMessage?: string;
}

export type SummaryRunStatus = "disabled" | "not_applicable" | "success" | "partial" | "failed" | "rate_limited";

export interface SummaryRunStats {
  status: SummaryRunStatus;
  attempted: number;
  succeeded: number;
  failed: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface ContentAnalysis {
  summary: string;
  contentType?: ContentTypeId;
  topicTags?: string[];
}

interface OpenAICompatibleOptions {
  name: string;
  defaultBaseUrl: string;
  defaultModel: string;
  apiKeyEnvKeys: string[];
}

/**
 * 默认跳过微信公众号：列表接口不返回正文（contentHtml 为空，text 只是微信 digest 引子），
 * 此阶段若生成摘要会得到「微信引子式」内容，与用户要求的「读完全文后的摘要」不符。
 * 要为微信生成真正摘要，需先在 werss-connector 的 collect 中抓取全文填入 contentHtml，
 * 再从跳过名单移除 wechat（后台「模型 API」勾选「微信公众号也使用模型 API」即等效）。
 *
 * 注意：后台可实时修改 SUMMARY_SKIP_PLATFORMS，因此必须每次调用时重新读取 env，
 * 不能缓存为模块级 const（worker 每轮把新值刷进 process.env，模块级 const 不会更新）。
 */
function summarySkipPlatforms(): Set<string> {
  return new Set(
    (process.env.SUMMARY_SKIP_PLATFORMS ?? "wechat")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * 给定平台当前是否应生成摘要：provider 已配置 且 平台未被跳过。
 * 供 werss-connector 判断是否要为微信抓取全文（只有真正要摘要时才值得花 22s/篇）。
 * 读取 env 为实时值（后台保存后下一轮 worker 刷新即生效）。
 */
export function isSummaryActiveFor(platform: string): boolean {
  if (summarySkipPlatforms().has(platform)) return false;
  const name = (process.env.SUMMARY_PROVIDER ?? "").trim().toLowerCase();
  return [
    "openai_compatible",
    "custom",
    "deepseek",
    "volcengine",
    "openai",
    "claude",
    "anthropic",
  ].includes(name);
}

const SUMMARY_TIMEOUT_MS = (Number(process.env.SUMMARY_TIMEOUT_SECONDS) || 20) * 1000;
const SUMMARY_MAX_CONCURRENCY = Math.max(1, Number(process.env.SUMMARY_MAX_CONCURRENCY) || 4);

/** 按 SUMMARY_PROVIDER 解析 provider；未配置/未知均返回 null（禁用）。 */
function resolveProvider(): SummaryProvider | null {
  const name = (process.env.SUMMARY_PROVIDER ?? "").trim().toLowerCase();
  switch (name) {
    case "openai_compatible":
    case "custom":
      return makeOpenAICompatibleProvider({
        name: "openai-compatible",
        defaultBaseUrl: process.env.SUMMARY_BASE_URL ?? "",
        defaultModel: process.env.SUMMARY_MODEL ?? "",
        apiKeyEnvKeys: ["SUMMARY_API_KEY"],
      });
    case "deepseek":
      return makeOpenAICompatibleProvider({
        name: "deepseek",
        defaultBaseUrl: "https://api.deepseek.com",
        defaultModel: "deepseek-v4-flash",
        apiKeyEnvKeys: ["SUMMARY_API_KEY", "DEEPSEEK_API_KEY"],
      });
    case "volcengine":
    case "ark":
      return makeOpenAICompatibleProvider({
        name: "volcengine-ark",
        defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        // 火山方舟通常需要填写自己的推理接入点 ID / 模型名，不在代码里猜。
        defaultModel: "",
        apiKeyEnvKeys: ["SUMMARY_API_KEY", "ARK_API_KEY", "VOLCENGINE_API_KEY"],
      });
    case "openai":
      return makeOpenAICompatibleProvider({
        name: "openai",
        defaultBaseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4o-mini",
        apiKeyEnvKeys: ["SUMMARY_API_KEY", "OPENAI_API_KEY"],
      });
    case "claude":
    case "anthropic":
      return makeClaudeProvider();
    case "":
    case "none":
    case "off":
    case "disabled":
      return null;
    default:
      console.warn(`[summarizer] 未知 SUMMARY_PROVIDER="${name}"，摘要生成已禁用`);
      return null;
  }
}

/**
 * 通用 OpenAI-compatible provider（直连 HTTPS API，无需安装 SDK 依赖）。
 * DeepSeek / 火山方舟 / 阿里百炼 / 智谱 / 硅基流动等只要兼容
 * `/chat/completions`，都走同一套代码。预设 provider 只提供默认 Base URL；
 * 自定义 provider 则完全由后台填写 `SUMMARY_BASE_URL` 与 `SUMMARY_MODEL`。
 * 任何网络/鉴权异常都会向上抛出，由 generateSummary 兜底为 null，绝不中断采集。
 */
function makeOpenAICompatibleProvider(options: OpenAICompatibleOptions): SummaryProvider {
  const apiKey = firstEnv(options.apiKeyEnvKeys);
  const baseUrl = (process.env.SUMMARY_BASE_URL || options.defaultBaseUrl).trim();
  const model = (process.env.SUMMARY_MODEL || options.defaultModel).trim();
  return {
    name: options.name,
    async generate(input: SummaryInput, signal?: AbortSignal): Promise<string> {
      if (!baseUrl) throw new Error("SUMMARY_BASE_URL_REQUIRED");
      if (!model) throw new Error("SUMMARY_MODEL_REQUIRED");
      if (!apiKey) throw new Error("SUMMARY_API_KEY_REQUIRED");

      const res = await fetch(chatCompletionsUrl(baseUrl), {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0.3,
          max_tokens: 220,
          messages: [
            {
              role: "system",
              content:
                "你是中文内容编辑。请输出严格 JSON，不要 Markdown。字段：summary（1-2句中文摘要，不要复述标题，不要营销口吻，不要使用“本文/这篇文章”等元表述）、content_type（只能是 product_update/model_release/industry_business/research/tutorial/policy_safety/opinion 之一）、topic_tags（2-5个中文或英文短标签，如 Agent、多模态、OpenAI、融资、MCP、Prompt、自动驾驶）。",
            },
            {
              role: "user",
              content: `标题：${input.title ?? ""}\n\n正文：\n${toPlainText(input)}`,
            },
          ],
        }),
      });
      if (!res.ok) {
        throw new Error(`${options.name} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const text = json.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error(`${options.name} 返回为空`);
      return text;
    },
  };
}

/**
 * Claude (Anthropic) provider（直连 HTTPS API，无需安装 SDK 依赖）。
 * 在后台选择 Claude 并填入 ANTHROPIC_API_KEY 即生效。
 */
function makeClaudeProvider(): SummaryProvider {
  const apiKey = firstEnv(["SUMMARY_API_KEY", "ANTHROPIC_API_KEY"]);
  const model = process.env.SUMMARY_MODEL ?? "claude-sonnet-4-0";
  return {
    name: "claude",
    async generate(input: SummaryInput, signal?: AbortSignal): Promise<string> {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 300,
        system:
            "你是中文内容编辑。请输出严格 JSON，不要 Markdown。字段：summary（1-2句中文摘要，不要复述标题，不要营销口吻，不要使用“本文/这篇文章”等元表述）、content_type（只能是 product_update/model_release/industry_business/research/tutorial/policy_safety/opinion 之一）、topic_tags（2-5个中文或英文短标签，如 Agent、多模态、OpenAI、融资、MCP、Prompt、自动驾驶）。",
          messages: [
            {
              role: "user",
              content: `标题：${input.title ?? ""}\n\n正文：\n${toPlainText(input)}`,
            },
          ],
        }),
      });
      if (!res.ok) {
        throw new Error(`Claude HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const json = (await res.json()) as {
        content?: { type: string; text?: string }[];
      };
      const text = json.content?.find((c) => c.type === "text")?.text?.trim();
      if (!text) throw new Error("Claude 返回为空");
      return text;
    },
  };
}

function firstEnv(keys: string[]): string {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return "";
}

function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

/** 优先用 contentHtml 去标签，回退纯文本 text。 */
function toPlainText(input: SummaryInput): string {
  if (input.contentHtml) {
    return input.contentHtml
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return (input.text ?? "").trim();
}

/** 是否已配置可用的 provider（供 ingest 判断是否走摘要分支）。 */
export function isSummaryEnabled(): boolean {
  try {
    return resolveProvider() !== null;
  } catch {
    return false;
  }
}

function classifySummaryError(providerName: string, err: unknown): Omit<SummaryAttemptResult, "provider"> {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (msg.includes("abort")) {
    return { status: "timeout", errorCode: "SUMMARY_TIMEOUT", errorMessage: msg };
  }
  if (/http\s*429/i.test(msg) || lower.includes("rate limit") || lower.includes("too many requests")) {
    return { status: "rate_limited", errorCode: "SUMMARY_RATE_LIMITED", errorMessage: msg };
  }
  if (/http\s*(401|403)/i.test(msg) || lower.includes("unauthorized") || lower.includes("forbidden")) {
    return { status: "failed", errorCode: "SUMMARY_AUTH_REQUIRED", errorMessage: msg };
  }
  if (msg.includes("_REQUIRED")) {
    return { status: "failed", errorCode: "SUMMARY_CONFIG_REQUIRED", errorMessage: msg };
  }
  return { status: "failed", errorCode: "SUMMARY_FAILED", errorMessage: `${providerName}: ${msg}` };
}

function stripJsonFence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

export function parseAnalysisResponse(text: string): ContentAnalysis {
  const cleaned = text.trim();
  try {
    const parsed = JSON.parse(stripJsonFence(cleaned)) as {
      summary?: unknown;
      content_type?: unknown;
      contentType?: unknown;
      topic_tags?: unknown;
      topicTags?: unknown;
      tags?: unknown;
    };
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    if (summary) {
      return {
        summary,
        contentType: normalizeContentType(
          typeof parsed.content_type === "string"
            ? parsed.content_type
            : typeof parsed.contentType === "string"
              ? parsed.contentType
              : undefined,
        ),
        topicTags: normalizeTopicTags(parsed.topic_tags ?? parsed.topicTags ?? parsed.tags),
      };
    }
  } catch {
    // Providers may still return a legacy plain-text summary; keep it usable.
  }
  return { summary: cleaned };
}

/** 单篇摘要尝试；返回结构化状态，绝不向上抛出。 */
export async function generateSummaryAttempt(item: NormalizedItem): Promise<SummaryAttemptResult> {
  if (summarySkipPlatforms().has(item.platform)) return { status: "skipped" };
  let provider: SummaryProvider | null = null;
  try {
    provider = resolveProvider();
  } catch {
    return { status: "disabled" };
  }
  if (!provider) return { status: "disabled" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SUMMARY_TIMEOUT_MS);
  try {
    const text = await provider.generate(
      {
        platform: item.platform,
        title: item.title,
        text: item.text,
        contentHtml: item.contentHtml,
        canonicalUrl: item.canonicalUrl,
        authorName: item.authorName,
      },
      ctrl.signal,
    );
    const analysis = parseAnalysisResponse(text);
    return analysis.summary
      ? {
          status: "success",
          summary: analysis.summary,
          contentType: analysis.contentType,
          topicTags: analysis.topicTags,
          provider: provider.name,
        }
      : { status: "failed", provider: provider.name, errorCode: "SUMMARY_EMPTY", errorMessage: "摘要返回为空" };
  } catch (err) {
    const classified = classifySummaryError(provider.name, err);
    if (classified.status === "timeout") console.warn(`[summarizer:${provider.name}] 超时(${SUMMARY_TIMEOUT_MS}ms)，跳过`);
    else console.error(`[summarizer:${provider.name}] 生成失败：${classified.errorMessage}`);
    return { ...classified, provider: provider.name };
  } finally {
    clearTimeout(timer);
  }
}

/** 单篇摘要；兼容旧调用方：任何非成功状态都返回 null。 */
export async function generateSummary(item: NormalizedItem): Promise<string | null> {
  const result = await generateSummaryAttempt(item);
  return result.status === "success" ? result.summary ?? null : null;
}

/**
 * 批量生成摘要（带并发限制）。返回 `platform|upstreamId` → 摘要 的 Map。
 * 仅对调用方传入的 items 生成，跳过在 SKIP_PLATFORMS 中的平台；异常项静默跳过。
 */
export async function generateSummaries(items: NormalizedItem[]): Promise<Map<string, string>> {
  const { summaries } = await generateSummariesWithStats(items);
  return summaries;
}

export async function generateSummariesWithStats(items: NormalizedItem[]): Promise<{
  summaries: Map<string, string>;
  analyses: Map<string, ContentAnalysis>;
  stats: SummaryRunStats;
}> {
  const out = new Map<string, string>();
  const analyses = new Map<string, ContentAnalysis>();
  const stats: SummaryRunStats = {
    status: isSummaryEnabled() ? "not_applicable" : "disabled",
    attempted: 0,
    succeeded: 0,
    failed: 0,
  };
  if (!items.length) return { summaries: out, analyses, stats };
  let cursor = 0;
  let lastError: Pick<SummaryRunStats, "errorCode" | "errorMessage"> = {};
  let sawRateLimit = false;
  let sawDisabled = false;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const idx = cursor++;
      const item = items[idx];
      const result = await generateSummaryAttempt(item);
      if (result.status === "skipped") continue;
      if (result.status === "disabled") {
        sawDisabled = true;
        continue;
      }
      stats.attempted += 1;
      if (result.status === "success" && result.summary) {
        stats.succeeded += 1;
        const key = `${item.platform}|${item.upstreamId}`;
        const analysis = {
          summary: result.summary,
          contentType: result.contentType,
          topicTags: result.topicTags,
        };
        out.set(key, result.summary);
        analyses.set(key, analysis);
      } else {
        stats.failed += 1;
        if (result.status === "rate_limited") sawRateLimit = true;
        lastError = {
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
        };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(SUMMARY_MAX_CONCURRENCY, items.length) }, worker),
  );
  if (stats.attempted === 0) {
    stats.status = sawDisabled ? "disabled" : "not_applicable";
  } else if (stats.failed === 0) {
    stats.status = "success";
  } else if (stats.succeeded > 0) {
    stats.status = "partial";
  } else {
    stats.status = sawRateLimit ? "rate_limited" : "failed";
  }
  stats.errorCode = lastError.errorCode;
  stats.errorMessage = lastError.errorMessage;
  return { summaries: out, analyses, stats };
}

/** 取条目的去重键（与 ingest-items 的 dedupeKey 解耦，这里用 platform+upstreamId 即可唯一定位）。 */
export function summaryKey(item: NormalizedItem): string {
  return `${item.platform}|${item.upstreamId}`;
}
