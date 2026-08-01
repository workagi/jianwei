import { NextResponse } from "next/server";
import { requireWriteAuth } from "@/lib/auth";
import { loadApiCredentials, saveApiCredentials } from "@/db/queries";

// 平台标识 -> 实际环境变量名（与 factory.ts / docker-compose 保持一致）。
const KEY_MAP: Record<string, string> = {
  x: "X_BEARER_TOKEN",
  web_search_brave: "BRAVE_SEARCH_API_KEY",
  web_search_tavily: "TAVILY_API_KEY",
  web_search_serper: "SERPER_API_KEY",
  wechat: "WERSS_ACCESS_KEY",
  zlzchat_base_url: "ZLZCHAT_BASE_URL",
  zlzchat_api_key: "ZLZCHAT_API_KEY",
};

/**
 * GET：返回各平台是否已配置凭据。仅返回布尔状态，绝不返回明文值。
 */
export async function GET(req: Request) {
  const denied = await requireWriteAuth(req);
  if (denied) return denied;

  const rows = await loadApiCredentials();
  const dbValues = new Map(rows.map((r) => [r.key, r.value]));
  const status: Record<string, boolean> = {};
  for (const [platform, key] of Object.entries(KEY_MAP)) {
    status[platform] = Boolean(dbValues.get(key)?.trim() || process.env[key]?.trim());
  }
  return NextResponse.json({ credentials: status });
}

/**
 * PUT：保存凭据。仅写入请求体中非空的字段（留空 = 不修改该项），
 * 避免误清空已配置的密钥。写入后立即对 worker 生效（无需重启）。
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

  const rows: { key: string; value: string }[] = [];
  for (const [platform, key] of Object.entries(KEY_MAP)) {
    const raw = body[platform];
    if (typeof raw === "string") {
      const v = raw.trim();
      if (v.length > 0) {
        if (platform === "zlzchat_base_url") {
          try {
            const url = new URL(v);
            if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("invalid");
            if (url.hostname === "111.229.83.152") {
              return NextResponse.json(
                { ok: false, error: "不能把 ZLZChat 配置指向已知公开演示地址；请使用经过安全审计的自建实例。" },
                { status: 422 },
              );
            }
          } catch {
            return NextResponse.json(
              { ok: false, error: "ZLZChat 地址必须是合法的 http/https URL，且不能在 URL 中包含账号密码。" },
              { status: 422 },
            );
          }
        }
        rows.push({ key, value: v });
      }
    }
  }
  if (typeof body.web_search === "string" && body.web_search.trim()) {
    rows.push({ key: "BRAVE_SEARCH_API_KEY", value: body.web_search.trim() });
  }

  if (rows.length === 0) {
    return NextResponse.json(
      { ok: false, error: "没有提供任何非空密钥（留空表示不修改）" },
      { status: 400 },
    );
  }

  await saveApiCredentials(rows);
  return NextResponse.json({ ok: true, updated: rows.map((r) => r.key) });
}
