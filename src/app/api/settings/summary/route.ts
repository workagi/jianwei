import { NextResponse } from "next/server";
import { requireWriteAuth } from "@/lib/auth";
import { loadApiCredentials, saveApiCredentials } from "@/db/queries";

// 模型 API provider 选项（与 src/lib/summarizer.ts 的 resolveProvider 对齐）。
// Next.js route modules 只能导出 HTTP handler / 少量框架字段；普通常量不能 export。
const SUMMARY_PROVIDERS = ["openai_compatible", "deepseek", "volcengine", "openai", "claude"] as const;
type SummaryProviderName = (typeof SUMMARY_PROVIDERS)[number];

const PROVIDER_OPTIONS: Record<SummaryProviderName, {
  label: string;
  defaultBaseUrl: string;
  defaultModel: string;
  help: string;
  apiKeyFallbacks: string[];
}> = {
  openai_compatible: {
    label: "自定义 OpenAI-compatible",
    defaultBaseUrl: "",
    defaultModel: "",
    help: "适合阿里百炼、智谱、硅基流动、OpenRouter 等兼容 /chat/completions 的服务。",
    apiKeyFallbacks: [],
  },
  deepseek: {
    label: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-v4-flash",
    help: "DeepSeek 官方 OpenAI-compatible API。",
    apiKeyFallbacks: ["DEEPSEEK_API_KEY"],
  },
  volcengine: {
    label: "火山方舟",
    defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    defaultModel: "",
    help: "火山方舟兼容 OpenAI SDK；模型名通常填你的推理接入点 ID / 模型 ID。",
    apiKeyFallbacks: ["ARK_API_KEY", "VOLCENGINE_API_KEY"],
  },
  openai: {
    label: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    help: "OpenAI 官方 Chat Completions API。",
    apiKeyFallbacks: ["OPENAI_API_KEY"],
  },
  claude: {
    label: "Claude (Anthropic)",
    defaultBaseUrl: "",
    defaultModel: "claude-sonnet-4-0",
    help: "Anthropic Messages API；不使用 OpenAI-compatible Base URL。",
    apiKeyFallbacks: ["ANTHROPIC_API_KEY"],
  },
};

function readPositiveInteger(value: string, fallback = ""): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? String(Math.floor(parsed)) : fallback;
}

function readClampedInteger(value: string, fallback: number, min: number, max: number): string {
  const parsed = Number(value);
  const normalized = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  return String(Math.min(max, Math.max(min, normalized)));
}

function readNonNegativeNumber(value: string, fallback = ""): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? String(parsed) : fallback;
}

/**
 * GET：返回模型 API 配置的当前状态。只回布尔/字符串，绝不返回明文密钥。
 */
export async function GET(req: Request) {
  const denied = await requireWriteAuth(req);
  if (denied) return denied;

  const rows = await loadApiCredentials();
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const getValue = (key: string, fallback = "") => byKey.get(key) ?? process.env[key] ?? fallback;
  const providerRaw = getValue("SUMMARY_PROVIDER").trim().toLowerCase();
  const provider = (SUMMARY_PROVIDERS as readonly string[]).includes(providerRaw)
    ? (providerRaw as SummaryProviderName)
    : "";
  const skip = getValue("SUMMARY_SKIP_PLATFORMS", "wechat")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const option = provider ? PROVIDER_OPTIONS[provider] : undefined;
  const baseUrl = getValue("SUMMARY_BASE_URL") || option?.defaultBaseUrl || "";
  const inferredRequestsPerMinute = baseUrl.toLowerCase().includes("api.stepfun.com") ? "10" : "";
  const hasApiKey = provider
    ? ["SUMMARY_API_KEY", ...(option?.apiKeyFallbacks ?? [])].some((key) => Boolean(getValue(key).trim()))
    : false;

  return NextResponse.json({
    available: SUMMARY_PROVIDERS,
    providers: SUMMARY_PROVIDERS.map((id) => ({ id, ...PROVIDER_OPTIONS[id] })),
    provider,
    baseUrl,
    model: getValue("SUMMARY_MODEL") || option?.defaultModel || "",
    hasApiKey,
    includeWechat: !skip.includes("wechat"),
    maxInputChars: readPositiveInteger(getValue("SUMMARY_MAX_INPUT_CHARS"), "3000"),
    maxConcurrency: readPositiveInteger(getValue("SUMMARY_MAX_CONCURRENCY"), "4"),
    requestsPerMinute: readPositiveInteger(getValue("SUMMARY_REQUESTS_PER_MINUTE"), inferredRequestsPerMinute),
    timeoutSeconds: readClampedInteger(getValue("SUMMARY_TIMEOUT_SECONDS"), 45, 10, 180),
    inputCostPerMillion: readNonNegativeNumber(getValue("SUMMARY_INPUT_COST_PER_1M_USD")),
    outputCostPerMillion: readNonNegativeNumber(getValue("SUMMARY_OUTPUT_COST_PER_1M_USD")),
  });
}

/**
 * PUT：保存模型 API 配置。留空的字段表示不修改（保留原值），避免误清空已配置的密钥。
 * provider 选「关闭」时存 "off"，worker 刷新后 summarizer 自动禁用。
 */
export async function PUT(req: Request) {
  const denied = await requireWriteAuth(req);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const rawProvider = typeof body.provider === "string" ? body.provider.trim().toLowerCase() : "";
  const provider = (SUMMARY_PROVIDERS as readonly string[]).includes(rawProvider)
    ? (rawProvider as SummaryProviderName)
    : "";
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const includeWechat = body.includeWechat === true;
  const maxInputChars = readPositiveInteger(typeof body.maxInputChars === "string" ? body.maxInputChars.trim() : "", "3000");
  const maxConcurrency = readPositiveInteger(typeof body.maxConcurrency === "string" ? body.maxConcurrency.trim() : "");
  const requestsPerMinute = readPositiveInteger(typeof body.requestsPerMinute === "string" ? body.requestsPerMinute.trim() : "");
  const timeoutSeconds = readClampedInteger(
    typeof body.timeoutSeconds === "string" ? body.timeoutSeconds.trim() : "",
    45,
    10,
    180,
  );
  const inputCostPerMillion = readNonNegativeNumber(
    typeof body.inputCostPerMillion === "string" ? body.inputCostPerMillion.trim() : "",
  );
  const outputCostPerMillion = readNonNegativeNumber(
    typeof body.outputCostPerMillion === "string" ? body.outputCostPerMillion.trim() : "",
  );

  const rows: { key: string; value: string }[] = [];

  // provider：关闭存 "off"（非空，确保能覆盖之前的 openai/claude）。
  rows.push({ key: "SUMMARY_PROVIDER", value: provider || "off" });

  // API Key：仅当本次提供了非空值才写入（留空 = 保留库中原值）。
  if (provider && apiKey) {
    rows.push({ key: "SUMMARY_API_KEY", value: apiKey });
  }

  // Base URL / 模型允许写空，用于清掉上一个 provider 的自定义值，回到预设默认。
  rows.push({ key: "SUMMARY_BASE_URL", value: baseUrl });
  rows.push({ key: "SUMMARY_MODEL", value: model });

  // 跳过平台：包含微信=true 时置空（不过滤），否则跳过微信（默认）。
  rows.push({ key: "SUMMARY_SKIP_PLATFORMS", value: includeWechat ? "" : "wechat" });
  rows.push({ key: "SUMMARY_MAX_INPUT_CHARS", value: maxInputChars });
  rows.push({ key: "SUMMARY_MAX_CONCURRENCY", value: maxConcurrency });
  rows.push({ key: "SUMMARY_REQUESTS_PER_MINUTE", value: requestsPerMinute });
  rows.push({ key: "SUMMARY_TIMEOUT_SECONDS", value: timeoutSeconds });
  rows.push({ key: "SUMMARY_INPUT_COST_PER_1M_USD", value: inputCostPerMillion });
  rows.push({ key: "SUMMARY_OUTPUT_COST_PER_1M_USD", value: outputCostPerMillion });

  await saveApiCredentials(rows);
  return NextResponse.json({ ok: true, provider: provider || "off", updated: rows.map((r) => r.key) });
}
