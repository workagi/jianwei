import { NextResponse } from "next/server";
import { requireWriteAuth } from "@/lib/auth";
import { loadApiCredentials } from "@/db/queries";

const SUMMARY_PROVIDERS = ["openai_compatible", "deepseek", "volcengine", "openai"] as const;
type SummaryProviderName = (typeof SUMMARY_PROVIDERS)[number];

const PROVIDER_DEFAULTS: Record<SummaryProviderName, {
  baseUrl: string;
  apiKeyFallbacks: string[];
}> = {
  openai_compatible: { baseUrl: "", apiKeyFallbacks: [] },
  deepseek: { baseUrl: "https://api.deepseek.com", apiKeyFallbacks: ["DEEPSEEK_API_KEY"] },
  volcengine: { baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKeyFallbacks: ["ARK_API_KEY", "VOLCENGINE_API_KEY"] },
  openai: { baseUrl: "https://api.openai.com/v1", apiKeyFallbacks: ["OPENAI_API_KEY"] },
};

interface ModelRow {
  id?: string;
  object?: string;
  owned_by?: string;
}

interface ModelsResponse {
  data?: ModelRow[];
}

function modelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  const normalized = trimmed.replace(/\/chat\/completions$/i, "");
  return `${normalized}/models`;
}

function isLikelyChatModel(id: string): boolean {
  return !/(embedding|embed|rerank|moderation|whisper|tts|audio|speech|asr|stt|transcrib|image|vision|ocr|search|gui)/i.test(id);
}

function filterModelIds(rows: ModelRow[]): string[] {
  const ids = Array.from(new Set(rows.map((row) => row.id?.trim()).filter(Boolean) as string[])).sort();
  const filtered = ids.filter(isLikelyChatModel);
  return filtered.length ? filtered : ids;
}

async function savedCredential(key: string): Promise<string | undefined> {
  const env = process.env[key]?.trim();
  if (env) return env;
  if (!process.env.DATABASE_URL) return undefined;
  const rows = await loadApiCredentials();
  return rows.find((row) => row.key === key)?.value?.trim() || undefined;
}

async function resolveApiKey(provider: SummaryProviderName, apiKeyFromRequest: string): Promise<string> {
  if (apiKeyFromRequest) return apiKeyFromRequest;
  const candidates = ["SUMMARY_API_KEY", ...PROVIDER_DEFAULTS[provider].apiKeyFallbacks];
  for (const key of candidates) {
    const value = await savedCredential(key);
    if (value) return value;
  }
  return "";
}

export async function POST(req: Request) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;

  let body: { provider?: string; baseUrl?: string; apiKey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const rawProvider = body.provider?.trim().toLowerCase() ?? "";
  if (!(SUMMARY_PROVIDERS as readonly string[]).includes(rawProvider)) {
    return NextResponse.json(
      { ok: false, error: "当前只支持 OpenAI-compatible / DeepSeek / 火山方舟 / OpenAI 自动检测模型。" },
      { status: 400 },
    );
  }

  const provider = rawProvider as SummaryProviderName;
  const baseUrl = body.baseUrl?.trim() || PROVIDER_DEFAULTS[provider].baseUrl;
  if (!baseUrl) {
    return NextResponse.json({ ok: false, error: "请先填写 Base URL，再检测可用模型。" }, { status: 422 });
  }

  const apiKey = await resolveApiKey(provider, body.apiKey?.trim() ?? "");
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "请先填写 API Key，或保存已配置的 API Key 后再检测。" }, { status: 422 });
  }

  try {
    const res = await fetch(modelsUrl(baseUrl), {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: `模型列表请求失败：HTTP ${res.status}`, detail: (await res.text()).slice(0, 300) },
        { status: 502 },
      );
    }
    const json = (await res.json()) as ModelsResponse;
    const models = filterModelIds(json.data ?? []);
    return NextResponse.json({
      ok: true,
      endpoint: modelsUrl(baseUrl),
      models,
      count: models.length,
      warning: models.length ? undefined : "服务返回了空模型列表；可以继续手动填写模型名。",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: `检测模型失败：${message}` }, { status: 502 });
  }
}
