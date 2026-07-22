import { NextResponse } from "next/server";
import { loadApiCredentials, saveApiCredentials } from "@/db/queries";
import { requireWriteAuth } from "@/lib/auth";
import { backfillWechatFullText } from "@/lib/wechat-content-backfill";
import { probeWechatFallback, testWechatFallbackArticle } from "@/lib/wechat-fallback-status";
import { db } from "@/db";
import { runtimeHealth } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

const DIRECT_KEY = "WECHAT_DIRECT_FALLBACK_ENABLED";
const FALLBACK_URL_KEY = "WECHAT_FALLBACK_BASE_URL";
const LAST_TEST_AT_KEY = "WECHAT_FALLBACK_LAST_TEST_AT";
const LAST_TEST_STATUS_KEY = "WECHAT_FALLBACK_LAST_TEST_STATUS";
const LAST_TEST_MESSAGE_KEY = "WECHAT_FALLBACK_LAST_TEST_MESSAGE";

function publicAdminUrl(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

async function currentSettings() {
  const rows = await loadApiCredentials();
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const directValue = values.get(DIRECT_KEY) ?? process.env[DIRECT_KEY] ?? "true";
  const fallbackBaseUrl = values.get(FALLBACK_URL_KEY) ?? process.env[FALLBACK_URL_KEY] ?? "";
  const lastTestAt = values.get(LAST_TEST_AT_KEY) ?? "";
  const lastTestStatus = values.get(LAST_TEST_STATUS_KEY) ?? "";
  const lastTestMessage = values.get(LAST_TEST_MESSAGE_KEY) ?? "";
  const [authHealth] = await db
    .select({ status: runtimeHealth.status, lastHeartbeatAt: runtimeHealth.lastHeartbeatAt, detail: runtimeHealth.detail })
    .from(runtimeHealth)
    .where(eq(runtimeHealth.service, "werss_auth"))
    .limit(1);
  return {
    directFallbackEnabled: directValue !== "false",
    fallbackBaseUrl,
    fallbackConfigured: Boolean(fallbackBaseUrl.trim()),
    fallback: await probeWechatFallback(fallbackBaseUrl),
    managementUrls: {
      werss: publicAdminUrl(process.env.WERSS_ADMIN_URL, "http://localhost:8001/wechat-status"),
      fallback: publicAdminUrl(process.env.WECHAT_FALLBACK_ADMIN_URL, "http://localhost:5055/admin.html"),
    },
    primaryAuth: authHealth
      ? {
          status: authHealth.status,
          checkedAt: authHealth.lastHeartbeatAt.toISOString(),
          account: typeof authHealth.detail.account === "string" ? authHealth.detail.account : undefined,
          expiryTimestamp: typeof authHealth.detail.expiryTimestamp === "number" ? authHealth.detail.expiryTimestamp : undefined,
          remainingSeconds: typeof authHealth.detail.remainingSeconds === "number" ? authHealth.detail.remainingSeconds : undefined,
          message: typeof authHealth.detail.message === "string" ? authHealth.detail.message : undefined,
        }
      : null,
    lastTest: lastTestAt
      ? {
          at: lastTestAt,
          status: lastTestStatus === "success" ? "success" : "failed",
          message: lastTestMessage,
        }
      : null,
  };
}

export async function GET(req: Request) {
  const denied = await requireWriteAuth(req);
  if (denied) return denied;
  return NextResponse.json(await currentSettings());
}

export async function PUT(req: Request) {
  const denied = await requireWriteAuth(req);
  if (denied) return denied;

  let body: { directFallbackEnabled?: unknown; fallbackBaseUrl?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }

  if (typeof body.directFallbackEnabled !== "boolean" || typeof body.fallbackBaseUrl !== "string") {
    return NextResponse.json({ ok: false, error: "全文通道设置不完整" }, { status: 422 });
  }
  const fallbackBaseUrl = body.fallbackBaseUrl.trim().replace(/\/$/, "");
  if (fallbackBaseUrl) {
    try {
      const parsed = new URL(fallbackBaseUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocol");
    } catch {
      return NextResponse.json({ ok: false, error: "备用服务地址必须是完整的 http:// 或 https:// 地址" }, { status: 422 });
    }
  }

  await saveApiCredentials([
    { key: DIRECT_KEY, value: body.directFallbackEnabled ? "true" : "false" },
    { key: FALLBACK_URL_KEY, value: fallbackBaseUrl },
  ]);
  return NextResponse.json({ ok: true, ...(await currentSettings()) });
}

export async function POST(req: Request) {
  const denied = await requireWriteAuth(req);
  if (denied) return denied;
  let body: { action?: unknown; limit?: unknown; articleUrl?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON" }, { status: 400 });
  }
  if (body.action === "backfill") {
    const result = await backfillWechatFullText(body.limit);
    return NextResponse.json({ ok: true, result });
  }
  if (body.action === "test") {
    if (typeof body.articleUrl !== "string") {
      return NextResponse.json({ ok: false, error: "请输入公众号文章链接" }, { status: 422 });
    }
    const rows = await loadApiCredentials();
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const fallbackBaseUrl = values.get(FALLBACK_URL_KEY) ?? process.env[FALLBACK_URL_KEY] ?? "";
    const testedAt = new Date().toISOString();
    try {
      const result = await testWechatFallbackArticle(fallbackBaseUrl, body.articleUrl);
      const contentLength = result.plainChars || result.contentChars;
      const message = `${result.title || "公众号文章"} · 已获取 ${contentLength} 字符正文`;
      await saveApiCredentials([
        { key: LAST_TEST_AT_KEY, value: testedAt },
        { key: LAST_TEST_STATUS_KEY, value: "success" },
        { key: LAST_TEST_MESSAGE_KEY, value: message.slice(0, 240) },
      ]);
      return NextResponse.json({ ok: true, result, testedAt, message });
    } catch (error) {
      const message = error instanceof Error ? error.message : "测试采集失败";
      await saveApiCredentials([
        { key: LAST_TEST_AT_KEY, value: testedAt },
        { key: LAST_TEST_STATUS_KEY, value: "failed" },
        { key: LAST_TEST_MESSAGE_KEY, value: message.slice(0, 240) },
      ]);
      return NextResponse.json({ ok: false, error: message, testedAt }, { status: 502 });
    }
  }
  return NextResponse.json({ ok: false, error: "不支持的操作" }, { status: 400 });
}
