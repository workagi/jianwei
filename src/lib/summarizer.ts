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
 * 在后台「模型 API」填写并保存后即对【新文章】自动生成中文标题、摘要、内容类型和主题标签。
 * 微信公众号需 werss-connector 抓取全文并填入 NormalizedItem.contentHtml（见 isSummaryActiveFor 守卫）。
 *
 * 调用方（ingest）已保证：仅对「新条目」生成、异常/超时一律兜底为 null，
 * 因此无论是否启用、无论 provider 是否实现完整，都不会中断采集或覆盖已有摘要。
 */
import type { NormalizedItem } from "@/connectors/types";
import { normalizeContentType, normalizeTopicTags, type ContentTypeId } from "@/lib/item-tags";
import { normalizeRelevanceScore, normalizeRetentionReason } from "@/lib/content-retention";
import { waitForDistributedRateLimit } from "@/lib/distributed-rate-limit";
import { createStructuredLogger } from "@/lib/structured-log";

const analysisLog = createStructuredLogger({ service: "content-analysis" });

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
  model: string;
  /** 返回中文 1–2 句内容摘要；失败抛错由调用方兜底为 null。signal 用于超时中断。 */
  generate(input: SummaryInput, signal?: AbortSignal, request?: RawGenerationRequest): Promise<ProviderGenerationResult>;
}

interface RawGenerationRequest {
  systemPrompt: string;
  userContent: string;
  maxTokens?: number;
}

interface ProviderGenerationResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

export type SummaryAttemptStatus = "success" | "skipped" | "disabled" | "failed" | "rate_limited" | "timeout";

export interface SummaryAttemptResult {
  status: SummaryAttemptStatus;
  summary?: string;
  translatedTitle?: string;
  contentType?: ContentTypeId;
  topicTags?: string[];
  retentionReason?: string;
  relevanceScore?: number;
  provider?: string;
  model?: string;
  errorCode?: string;
  errorMessage?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export type SummaryRunStatus = "disabled" | "not_applicable" | "success" | "partial" | "failed" | "rate_limited";

export interface SummaryRunStats {
  status: SummaryRunStatus;
  attempted: number;
  succeeded: number;
  failed: number;
  inputTokens?: number;
  outputTokens?: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface ContentAnalysis {
  summary: string;
  translatedTitle?: string;
  contentType?: ContentTypeId;
  topicTags?: string[];
  retentionReason?: string;
  relevanceScore?: number;
}

interface OpenAICompatibleOptions {
  name: string;
  defaultBaseUrl: string;
  defaultModel: string;
  apiKeyEnvKeys: string[];
}

const ANALYSIS_SYSTEM_PROMPT = [
  "你是中文内容编辑，只能输出一个合法 JSON 对象。",
  "不要输出推理过程、分析过程、字段解释、Markdown、代码块或任何 JSON 之外的文字。",
  "不要输出“可以写”“要准确概括”“对，这个可以”等口语化自我检查。",
  "JSON 字段固定为：translated_title、summary、content_type、topic_tags、keep_reason、relevance_score。",
  "translated_title：普通文章输出自然、准确的中文标题；原题已是中文时保持原意和措辞，原题是外文时忠实翻译。平台为 x 时，它不是文章标题，而是前台显示的中文推文：逐句忠实翻译正文，保留原有事实、语气、产品名、人名、机构名、模型名、必要缩写和 @用户名，不概括、不改写成新闻标题；中文推文保持原文。非 x 内容没有标题时输出空字符串。",
  "summary：1-2句中文摘要，不要复述标题，不要营销口吻，不要使用“本文/这篇文章”等元表述。",
  "如果正文很短，就基于标题、来源和已有文本给出一句事实概括；不要说“信息不足”。",
  "content_type：只能是 product_update/model_release/industry_business/research/tutorial/policy_safety/opinion 之一。",
  "topic_tags：2-5个中文或英文短标签，如 Agent、多模态、OpenAI、融资、MCP、Prompt、自动驾驶。",
  "keep_reason：25-70字，回答‘这条内容具体新增了什么、为什么应从同类信息中留下’。必须写出具体实体，以及动作、变化、数字、影响或可复用方法中的至少一项；可以做编辑判断，但必须有正文事实支撑。不要重复summary，不要代入用户兴趣，不要使用“你正在关注、为你推荐”。",
  "keep_reason 禁止只写分类占位语，例如‘包含XX相关的产品动态信息’、‘包含可核对的论文研究信息’、‘有明确主题的关键解读’、‘具备参考价值’；如果无法指出具体信息增量，输出空字符串。",
  "relevance_score：0-100整数。内容已通过订阅或关键词初筛，请按信息具体程度、可验证性和实际参考价值评分，不要按来源名气评分。",
].join("\n");

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

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function summaryTimeoutSeconds(): number {
  return positiveInt(process.env.SUMMARY_TIMEOUT_SECONDS, 45);
}

function summaryTimeoutMs(): number {
  return summaryTimeoutSeconds() * 1000;
}

export function summaryMaxInputChars(): number {
  // 公众号常见 2k–4k 字，默认 3000 覆盖平均篇幅；后台可上调到深度长文档位。
  return positiveInt(process.env.SUMMARY_MAX_INPUT_CHARS, 3_000);
}

export function summaryMaxConcurrency(): number {
  return positiveInt(process.env.SUMMARY_MAX_CONCURRENCY, 4);
}

export function summaryRequestsPerMinute(): number {
  const configured = Number(process.env.SUMMARY_REQUESTS_PER_MINUTE);
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);

  // 阶跃星辰低额度账号常见限制是 RPM 10。用户如果已升级额度，可在后台覆盖。
  const baseUrl = (process.env.SUMMARY_BASE_URL ?? "").toLowerCase();
  return baseUrl.includes("api.stepfun.com") ? 10 : 0;
}

export function summaryRequestIntervalMs(): number {
  const explicit = Number(process.env.SUMMARY_REQUEST_INTERVAL_MS);
  if (Number.isFinite(explicit) && explicit > 0) return Math.ceil(explicit);
  const rpm = summaryRequestsPerMinute();
  return rpm > 0 ? Math.ceil(60_000 / rpm) : 0;
}

export function summaryRateLimitKey(provider: Pick<SummaryProvider, "name" | "model">): string {
  const configured = process.env.SUMMARY_RATE_LIMIT_KEY?.trim();
  return configured || `summary:${provider.name}:${provider.model}`;
}

async function waitForSummaryRateLimit(provider: SummaryProvider): Promise<void> {
  const intervalMs = summaryRequestIntervalMs();
  if (intervalMs <= 0) return;
  await waitForDistributedRateLimit(summaryRateLimitKey(provider), intervalMs);
}

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
      analysisLog.warn("analysis.provider.unknown", { provider: name });
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
    model,
    async generate(input: SummaryInput, signal?: AbortSignal, request?: RawGenerationRequest): Promise<ProviderGenerationResult> {
      if (!baseUrl) throw new Error("SUMMARY_BASE_URL_REQUIRED");
      if (!model) throw new Error("SUMMARY_MODEL_REQUIRED");
      if (!apiKey) throw new Error("SUMMARY_API_KEY_REQUIRED");

      const isStepFunFlash2603 =
        baseUrl.toLowerCase().includes("api.stepfun.com") &&
        model.toLowerCase() === "step-3.5-flash-2603";
      const requestBody: Record<string, unknown> = {
        model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: request?.systemPrompt ?? ANALYSIS_SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: request?.userContent ?? `请只返回 JSON，不要解释。\n\n平台：${input.platform}\n\n标题：${input.title ?? ""}\n\n正文：\n${toPlainText(input)}`,
          },
        ],
      };

      if (isStepFunFlash2603) {
        // 官方支持 low/high 两档。摘要与标签属于确定性提取任务，低推理既省 token，
        // 也避免推理内容先占满较小的 max_tokens，导致最终 JSON 被截断。
        requestBody.reasoning_effort = "low";
      } else {
        // 非推理模型保留一个宽松但有限的输出预算；足够容纳摘要与结构化字段。
        requestBody.max_tokens = request?.maxTokens ?? 420;
      }

      const send = (body: Record<string, unknown>) => fetch(chatCompletionsUrl(baseUrl), {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
      let res = await send(requestBody);
      if (!res.ok) {
        const errorText = (await res.text()).slice(0, 500);
        const responseFormatUnsupported =
          res.status === 400 &&
          /response[_\s-]*format|json[_\s-]*(?:object|mode)|unsupported.*(?:json|format)|不支持.*(?:json|格式)/i.test(errorText);
        if (responseFormatUnsupported) {
          const compatibleBody = { ...requestBody };
          delete compatibleBody.response_format;
          res = await send(compatibleBody);
        } else {
          throw new Error(`${options.name} HTTP ${res.status}: ${errorText.slice(0, 200)}`);
        }
      }
      if (!res.ok) {
        throw new Error(`${options.name} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const json = (await res.json()) as {
        choices?: {
          message?: {
            content?: unknown;
            text?: unknown;
            reasoning_content?: unknown;
          };
          text?: unknown;
          finish_reason?: unknown;
        }[];
        usage?: {
          prompt_tokens?: unknown;
          completion_tokens?: unknown;
          input_tokens?: unknown;
          output_tokens?: unknown;
        };
      };
      const finishReason = typeof json.choices?.[0]?.finish_reason === "string"
        ? json.choices[0].finish_reason.toLowerCase()
        : "";
      if (finishReason === "length" || finishReason === "max_tokens") {
        throw new Error("SUMMARY_OUTPUT_TRUNCATED");
      }
      const text = extractOpenAICompatibleText(json);
      if (!text) throw new Error(`${options.name} 返回为空`);
      return {
        text,
        inputTokens: normalizeTokenCount(json.usage?.prompt_tokens ?? json.usage?.input_tokens),
        outputTokens: normalizeTokenCount(json.usage?.completion_tokens ?? json.usage?.output_tokens),
      };
    },
  };
}

function extractOpenAICompatibleText(json: {
  choices?: {
    message?: {
      content?: unknown;
      text?: unknown;
      reasoning_content?: unknown;
    };
    text?: unknown;
  }[];
}): string | undefined {
  const choice = json.choices?.[0];
  const message = choice?.message;
  const candidates = [
    message?.content,
    message?.text,
    choice?.text,
    message?.reasoning_content,
  ];
  for (const candidate of candidates) {
    const text = normalizeProviderText(candidate);
    if (text) return text;
  }
  return undefined;
}

function normalizeProviderText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        const maybe = part as { text?: unknown; content?: unknown };
        if (typeof maybe.text === "string") return maybe.text;
        if (typeof maybe.content === "string") return maybe.content;
      }
      return "";
    })
    .join("")
    .trim();
  return text || undefined;
}

function normalizeTokenCount(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
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
    model,
    async generate(input: SummaryInput, signal?: AbortSignal, request?: RawGenerationRequest): Promise<ProviderGenerationResult> {
      if (!apiKey) throw new Error("SUMMARY_API_KEY_REQUIRED");
      if (!model.trim()) throw new Error("SUMMARY_MODEL_REQUIRED");
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
          max_tokens: request?.maxTokens ?? 300,
          system: request?.systemPrompt ?? ANALYSIS_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: request?.userContent ?? `请只返回 JSON，不要解释。\n\n标题：${input.title ?? ""}\n\n正文：\n${toPlainText(input)}`,
            },
          ],
        }),
      });
      if (!res.ok) {
        throw new Error(`Claude HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const json = (await res.json()) as {
        content?: { type: string; text?: string }[];
        stop_reason?: unknown;
        usage?: {
          input_tokens?: unknown;
          output_tokens?: unknown;
        };
      };
      if (json.stop_reason === "max_tokens") throw new Error("SUMMARY_OUTPUT_TRUNCATED");
      const text = json.content?.find((c) => c.type === "text")?.text?.trim();
      if (!text) throw new Error("Claude 返回为空");
      return {
        text,
        inputTokens: normalizeTokenCount(json.usage?.input_tokens),
        outputTokens: normalizeTokenCount(json.usage?.output_tokens),
      };
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

function decodeCommonHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function compactText(text: string): string {
  return decodeCommonHtmlEntities(text)
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtmlToText(html: string): string {
  return compactText(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  );
}

/**
 * 控制模型输入长度：保留开头的主要信息，也保留末尾少量结论/作者补充。
 * 字符上限不是精确 token 上限，但对中文公众号更直观，也足够做成本保护。
 */
function limitTextForModel(text: string): string {
  const maxChars = summaryMaxInputChars();
  if (text.length <= maxChars) return text;

  const headLength = Math.max(1, Math.floor(maxChars * 0.82));
  const tailLength = Math.max(0, maxChars - headLength);
  const head = text.slice(0, headLength).trimEnd();
  const tail = tailLength > 0 ? text.slice(-tailLength).trimStart() : "";
  return `${head}\n\n[中间内容已按后台预算设置省略，模型仍保留文章开头和结尾用于判断。]\n\n${tail}`.trim();
}

/** 优先用 contentHtml 去标签，回退纯文本 text，并按后台预算限制长度。 */
function toPlainText(input: SummaryInput): string {
  const text = input.contentHtml ? stripHtmlToText(input.contentHtml) : compactText(input.text ?? "");
  return limitTextForModel(text);
}

function looksLikePromoSentence(text: string): boolean {
  return /加我|进群|联系方式|右下角|开源知识库|全免费|请.*收藏|请.*转发|青年大学习|扫码|二维码|点击蓝字|原文链接|文末|评论区见/i.test(text);
}

function removeLeadingPromoNoise(text: string): string {
  return text
    .replace(/^(?:加我|加入|进).{0,80}?(?:联系方式|进群|讨论群|学习群).{0,80}?(?:全免费|免费)?\s*/i, "")
    .replace(/^文末有.{0,80}?(?:开源知识库|联系方式).{0,40}?\s*/i, "")
    .replace(/^请.{0,20}?(?:收藏|转发).{0,40}?\s*/i, "")
    .trim();
}

function fallbackSummaryFromFullText(input: SummaryInput): string {
  if (input.platform !== "wechat" || !input.contentHtml?.trim()) return "";
  const title = (input.title ?? "").trim();
  const text = removeLeadingPromoNoise(toPlainText(input))
    .replace(/\s+/g, " ")
    .trim();
  const sentences = text
    .split(/(?<=[。！？!?])\s*/)
    .map((sentence) => sanitizeSummaryText(sentence.trim()))
    .filter((sentence) => sentence.length >= 18 && sentence.length <= 220)
    .filter((sentence) => !looksLikePromoSentence(sentence))
    .filter((sentence) => !title || sentence !== title);

  const picked: string[] = [];
  for (const sentence of sentences) {
    picked.push(sentence);
    if (picked.join("").length >= 80 || picked.length >= 2) break;
  }
  const summary = picked.join("");
  return isUsableSummary(summary) ? summary : "";
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
  if (msg.includes("SUMMARY_OUTPUT_TRUNCATED")) {
    return { status: "failed", errorCode: "SUMMARY_OUTPUT_TRUNCATED", errorMessage: "模型输出达到上限，结构化结果不完整" };
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

function extractJsonCandidate(text: string): string | null {
  const stripped = stripJsonFence(text);
  if (stripped.startsWith("{") && stripped.endsWith("}")) return stripped;
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start >= 0 && end > start) return stripped.slice(start, end + 1).trim();
  return null;
}

function looksLikePromptLeakage(text: string): boolean {
  return /我现在需要处理|用户现在需要处理|处理用户的请求|首先\s*summary|首先.*字段|先看要求|等下|content_type|topic_tags|"summary"\s*:|要\s*1\s*[-到至]\s*2\s*句|1\s*[-到至]\s*2\s*句中文|要准确概括|要概括|可以写|对[，,]?\s*这个可以|不要复述标题|不能复述标题|不要营销|不用元表述|不要元表述|信息不足|暂无法形成可靠摘要|严格\s*JSON|字段[:：]\s*summary|^\s*\{/i.test(text);
}

function sanitizeSummaryText(value: string): string {
  return value
    .replace(/^部分[：:，,\s]*/i, "")
    .replace(/^(?:部分)?[，,：:\s]*(?:要准确概括|准确概括)[，,：:\s]*/i, "")
    .replace(/^(?:要概括这个研究的内容|要概括)[，,：:\s]*(?:就是|是)?[，,：:\s]*/i, "")
    .replace(/^(?:核心|核心事件)[：:\s]*/i, "")
    .replace(/[，,。；;\s]*(?:对[，,]?\s*)?这个可以[。.!！]*$/i, "")
    .replace(/[，,。；;\s]*那(?:summary)?(?:可以)?(?:写|是)[\s\S]*$/i, "")
    .replace(/[，,。；;\s]*(?:还有|并提供了?)(?:相关)?(?:讨论|评论)(?:和|及)?(?:链接入口|链接|入口)?[。！？!?]*$/i, "")
    .replace(/[，,。；;\s]*(?:还有|并提供了?)(?:相关)?(?:链接|入口)[。！？!?]*$/i, "")
    .replace(/[？?]+$/u, "。")
    .replace(/\s+/g, " ")
    .trim();
}

function isUsableSummary(summary: string): boolean {
  if (!summary || summary.length > 500) return false;
  if (looksLikePromptLeakage(summary)) return false;
  if (/summary|正文没给|正文没有内容|先看要求|相关内容[。！？?]?$/i.test(summary)) return false;
  return true;
}

function normalizeTranslatedTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const title = value
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, "")
    .replace(/^(?:中文标题|标题翻译|translated_title)\s*[：:]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!title || title.length > 500 || looksLikePromptLeakage(title)) return undefined;
  return title;
}

/** Reader and maintenance jobs use the same quality gate as new model output. */
export function normalizeSummaryForDisplay(value?: string | null): string {
  if (!value?.trim()) return "";
  const summary = sanitizeSummaryText(value.trim());
  return isUsableSummary(summary) ? summary : "";
}

function normalizeAnalysisJson(text: string): ContentAnalysis | null {
  try {
    const parsed = JSON.parse(text) as {
      summary?: unknown;
      translated_title?: unknown;
      translatedTitle?: unknown;
      content_type?: unknown;
      contentType?: unknown;
      topic_tags?: unknown;
      topicTags?: unknown;
      tags?: unknown;
      keep_reason?: unknown;
      retention_reason?: unknown;
      relevance_score?: unknown;
    };
    const summary = typeof parsed.summary === "string" ? sanitizeSummaryText(parsed.summary.trim()) : "";
    if (summary) {
      if (!isUsableSummary(summary)) return null;
      return {
        summary,
        translatedTitle: normalizeTranslatedTitle(parsed.translated_title ?? parsed.translatedTitle),
        contentType: normalizeContentType(
          typeof parsed.content_type === "string"
            ? parsed.content_type
            : typeof parsed.contentType === "string"
              ? parsed.contentType
              : undefined,
        ),
        topicTags: normalizeTopicTags(parsed.topic_tags ?? parsed.topicTags ?? parsed.tags),
        retentionReason: normalizeRetentionReason(parsed.keep_reason ?? parsed.retention_reason),
        relevanceScore: normalizeRelevanceScore(parsed.relevance_score),
      };
    }
  } catch {
    return null;
  }
  return null;
}

const CONTENT_TYPE_IDS: ContentTypeId[] = [
  "product_update",
  "model_release",
  "industry_business",
  "research",
  "tutorial",
  "policy_safety",
  "opinion",
];

function cleanReasoningSummary(value: string): string {
  return sanitizeSummaryText(value)
    .replace(/^.*?(?:那)?summary(?:的话)?(?:应该是|可以写|就写|写成|是|为|：|:)[\s"'“”‘’：:，,。]*/i, "")
    .replace(/^因为正文(?:没给|没有内容|没内容|只有标题)[^，。！？]*[，。！？]*/i, "")
    .replace(/^(?:要准确|清楚|明确)[，,：:\s]*(?:就是|是)?[，,：:\s]*/i, "")
    .replace(/^(?:说|就是)[，,：:\s]*/i, "")
    .replace(/^[\s"'“”‘’：:，,。]*(?:比如|可以写|应该是|写|是|为)?[\s"'“”‘’：:，,。]*/i, "")
    .replace(/["'“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseReasoningAnalysis(text: string): ContentAnalysis | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  const summaryMatch =
    /summary(?:的话|应该|可以|是|要写)?[，,。\s]*(?:应该是|可以写|是|为|：|:)?[“"']?([\s\S]{12,420}?)(?=(?:[”"']?\s*(?:然后|接着|再看|content_type|内容类型|topic_tags|标签|$)))/i.exec(normalized) ??
    /摘要(?:的话|应该|可以|是|要写)?[，,。\s]*(?:应该是|可以写|是|为|：|:)?[“"']?([\s\S]{12,420}?)(?=(?:[”"']?\s*(?:然后|接着|再看|content_type|内容类型|topic_tags|标签|$)))/i.exec(normalized);
  const summary = summaryMatch ? cleanReasoningSummary(summaryMatch[1]) : "";
  if (!isUsableSummary(summary)) return null;

  const typeMatch = new RegExp(`(?:content_type|内容类型)[\\s\\S]{0,80}?(${CONTENT_TYPE_IDS.join("|")})`, "i").exec(normalized);
  const tagMatch = /(?:topic_tags|标签)(?:的话)?[\s\S]{0,40}?(?:比如|是|为|：|:)?([\u4e00-\u9fa5A-Za-z0-9_\- /、，,]{2,120})/i.exec(normalized);
  const rawTags = tagMatch?.[1]
    ?.split(/[、，,\s/]+/)
    .map((tag) => tag.replace(/^(?:的话|比如)/, "").trim())
    .filter(Boolean)
    .slice(0, 5);

  return {
    summary,
    contentType: normalizeContentType(typeMatch?.[1]),
    topicTags: normalizeTopicTags(rawTags),
  };
}

export function parseAnalysisResponse(text: string): ContentAnalysis {
  const cleaned = text.trim();
  const jsonCandidate = extractJsonCandidate(cleaned);
  if (jsonCandidate) {
    const parsed = normalizeAnalysisJson(jsonCandidate);
    if (parsed) return parsed;
  }
  const stripped = stripJsonFence(cleaned);
  // A response that starts like structured data but cannot be parsed is almost
  // certainly truncated or malformed JSON. Never persist it as human copy.
  if (/^[{[]/.test(stripped) || /"(?:summary|content_type|topic_tags|keep_reason)"\s*:/i.test(stripped)) {
    return { summary: "" };
  }

  if (looksLikePromptLeakage(cleaned)) {
    const parsed = parseReasoningAnalysis(cleaned);
    return parsed ?? { summary: "" };
  }
  if (cleaned.length > 500) return { summary: "" };

  // Providers may still return a legacy plain-text summary; keep it usable
  // only when it looks like a short human-facing summary, not model reasoning.
  const summary = sanitizeSummaryText(cleaned);
  return { summary: isUsableSummary(summary) ? summary : "" };
}

export interface TitleTranslationInput {
  id: string;
  title: string;
}

/**
 * 批量翻译历史外文标题。新内容无需调用此函数，因为标题中文化已经包含在
 * 正常内容理解请求中；这里只用于低成本补齐旧数据。
 */
export async function generateTitleTranslations(entries: TitleTranslationInput[]): Promise<Map<string, string>> {
  const translations = new Map<string, string>();
  if (!entries.length) return translations;
  const provider = resolveProvider();
  if (!provider) return translations;

  // 批量历史标题比单篇摘要输出更长，使用独立的宽松预算；失败仍不会写入脏数据。
  const timeoutMs = Math.max(summaryTimeoutMs(), 60_000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await waitForSummaryRateLimit(provider);
    const ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const generated = await provider.generate(
      { platform: "trendradar", text: "" },
      ctrl.signal,
      {
        systemPrompt: [
          "你是中文资讯标题编辑，只能输出合法 JSON。",
          "逐条把外文标题忠实翻译成自然、简洁的中文。",
          "保留产品名、机构名、人物名、模型名、版本号和必要缩写，不添加原标题没有的事实或判断。",
          "输出格式固定为：{\"translations\":[{\"id\":\"原id\",\"title_zh\":\"中文标题\"}]}。",
          "不要输出解释、Markdown、代码块或遗漏 id。",
        ].join("\n"),
        userContent: JSON.stringify({ titles: entries }),
        maxTokens: Math.max(500, entries.length * 80),
      },
    );
    const candidate = extractJsonCandidate(generated.text);
    if (!candidate) return translations;
    const parsed = JSON.parse(candidate) as { translations?: Array<{ id?: unknown; title_zh?: unknown; titleZh?: unknown }> };
    const allowed = new Set(entries.map((entry) => entry.id));
    for (const row of parsed.translations ?? []) {
      const id = typeof row.id === "string" ? row.id : "";
      const title = normalizeTranslatedTitle(row.title_zh ?? row.titleZh);
      if (allowed.has(id) && title) translations.set(id, title);
    }
    return translations;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    analysisLog.warn("analysis.title_translation.failed", {
      provider: provider.name,
      model: provider.model,
      itemCount: entries.length,
      errorMessage: message,
    });
    return translations;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 单篇摘要尝试；返回结构化状态，绝不向上抛出。 */
export async function generateSummaryAttempt(item: NormalizedItem): Promise<SummaryAttemptResult> {
  if (summarySkipPlatforms().has(item.platform)) return { status: "skipped" };
  if (item.platform === "wechat" && !item.contentHtml?.trim()) {
    return {
      status: "skipped",
      errorCode: "WECHAT_FULL_TEXT_REQUIRED",
      errorMessage: "微信公众号摘要需要先抓取全文 HTML",
    };
  }
  let provider: SummaryProvider | null = null;
  try {
    provider = resolveProvider();
  } catch {
    return { status: "disabled" };
  }
  if (!provider) return { status: "disabled" };
  const timeoutMs = summaryTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await waitForSummaryRateLimit(provider);
    const ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const generated = await provider.generate(
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
    const analysis = parseAnalysisResponse(generated.text);
    const fallbackSummary = analysis.summary ? "" : fallbackSummaryFromFullText({
      platform: item.platform,
      title: item.title,
      text: item.text,
      contentHtml: item.contentHtml,
      canonicalUrl: item.canonicalUrl,
      authorName: item.authorName,
    });
    const summary = analysis.summary || fallbackSummary;
    return summary
      ? {
          status: "success",
          summary,
          translatedTitle: analysis.translatedTitle,
          contentType: analysis.contentType,
          topicTags: analysis.topicTags,
          retentionReason: analysis.retentionReason,
          relevanceScore: analysis.relevanceScore,
          provider: fallbackSummary ? `${provider.name}+local-fallback` : provider.name,
          model: provider.model,
          inputTokens: generated.inputTokens,
          outputTokens: generated.outputTokens,
        }
      : { status: "failed", provider: provider.name, model: provider.model, errorCode: "SUMMARY_EMPTY", errorMessage: "摘要返回为空" };
  } catch (err) {
    const classified = classifySummaryError(provider.name, err);
    const fields = {
      provider: provider.name,
      model: provider.model,
      platform: item.platform,
      upstreamId: item.upstreamId,
      timeoutMs,
      status: classified.status,
      errorCode: classified.errorCode,
      errorMessage: classified.errorMessage,
    };
    if (classified.status === "timeout" || classified.status === "rate_limited") {
      analysisLog.warn("analysis.item.failed", fields);
    } else {
      analysisLog.error("analysis.item.failed", fields);
    }
    return { ...classified, provider: provider.name, model: provider.model };
  } finally {
    if (timer) clearTimeout(timer);
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
  attempts: Map<string, SummaryAttemptResult>;
  stats: SummaryRunStats;
}> {
  const startedAt = Date.now();
  const out = new Map<string, string>();
  const analyses = new Map<string, ContentAnalysis>();
  const attempts = new Map<string, SummaryAttemptResult>();
  const stats: SummaryRunStats = {
    status: isSummaryEnabled() ? "not_applicable" : "disabled",
    attempted: 0,
    succeeded: 0,
    failed: 0,
  };
  if (!items.length) return { summaries: out, analyses, attempts, stats };
  let cursor = 0;
  let lastError: Pick<SummaryRunStats, "errorCode" | "errorMessage"> = {};
  let sawRateLimit = false;
  let sawDisabled = false;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const idx = cursor++;
      const item = items[idx];
      const result = await generateSummaryAttempt(item);
      attempts.set(summaryKey(item), result);
      stats.inputTokens = (stats.inputTokens ?? 0) + (result.inputTokens ?? 0);
      stats.outputTokens = (stats.outputTokens ?? 0) + (result.outputTokens ?? 0);
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
          translatedTitle: result.translatedTitle,
          contentType: result.contentType,
          topicTags: result.topicTags,
          retentionReason: result.retentionReason,
          relevanceScore: result.relevanceScore,
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
    Array.from({ length: Math.min(summaryMaxConcurrency(), items.length) }, worker),
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
  analysisLog.info("analysis.batch.completed", {
    durationMs: Date.now() - startedAt,
    itemCount: items.length,
    status: stats.status,
    attempted: stats.attempted,
    succeeded: stats.succeeded,
    failed: stats.failed,
    inputTokens: stats.inputTokens ?? 0,
    outputTokens: stats.outputTokens ?? 0,
    errorCode: stats.errorCode,
  });
  return { summaries: out, analyses, attempts, stats };
}

/** 取条目的去重键（与 ingest-items 的 dedupeKey 解耦，这里用 platform+upstreamId 即可唯一定位）。 */
export function summaryKey(item: NormalizedItem): string {
  return `${item.platform}|${item.upstreamId}`;
}
