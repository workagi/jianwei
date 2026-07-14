import { NextResponse } from "next/server";
import { db } from "@/db";
import { monitors } from "@/db/schema";
import { desc } from "drizzle-orm";
import { connectorIdForPlatform } from "@/db/connector-seed";
import {
  xMonitorSchema,
  wechatMonitorSchema,
  webSearchMonitorSchema,
  isWechatKeywordRuleConfig,
  type PlatformType,
  type WechatMonitorConfig,
} from "@/connectors/types";
import { createRuntimeWeRssConnector } from "@/connectors/factory";
import { requireWriteAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Only the three direct-connector platforms are created through this API.
// TrendRadar monitors are configured in infra/trendradar/config, not here.
const SCHEMA_MAP = {
  x: xMonitorSchema,
  wechat: wechatMonitorSchema,
  web_search: webSearchMonitorSchema,
} as const;

type SupportedPlatform = keyof typeof SCHEMA_MAP;

function defaultName(platform: SupportedPlatform, config: Record<string, unknown>): string {
  if (platform === "x") return `@${config.username ?? "x"}`;
  if (platform === "wechat") {
    if (config.kind === "keyword_rule") return `${config.query ?? "关键词"} · 公众号关键词`;
    const mpName = typeof config.mpName === "string" ? config.mpName.trim() : "";
    return mpName || "微信公众号";
  }
  return (config.query as string) ?? "全网监控";
}

function usefulWechatName(name: string | undefined): string | undefined {
  const trimmed = name?.trim();
  return trimmed && trimmed !== "未知公众号" ? trimmed : undefined;
}

export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ ok: false, error: "DATABASE_URL 未配置" }, { status: 503 });
  }
  const rows = await db.select().from(monitors).orderBy(desc(monitors.updatedAt));
  return NextResponse.json({ ok: true, monitors: rows });
}

export async function POST(req: Request) {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ ok: false, error: "DATABASE_URL 未配置" }, { status: 503 });
  }

  const denied = requireWriteAuth(req);
  if (denied) return denied;

  let body: { platform?: string; name?: string; config?: unknown; pollIntervalMinutes?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "无效的 JSON 请求体" }, { status: 400 });
  }

  const { platform, config, name, pollIntervalMinutes } = body;
  if (typeof platform !== "string" || !(platform in SCHEMA_MAP)) {
    return NextResponse.json({ ok: false, error: `不支持的平台: ${platform ?? "（空）"}` }, { status: 400 });
  }

  const schema = SCHEMA_MAP[platform as SupportedPlatform];
  const parsed = schema.safeParse(config ?? {});
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "配置校验失败", detail: parsed.error.flatten() }, { status: 422 });
  }

  const connectorId = connectorIdForPlatform(platform as PlatformType);
  if (!connectorId) {
    return NextResponse.json({ ok: false, error: "连接器未初始化，请先运行 `pnpm db:seed`" }, { status: 500 });
  }

  // WeChat account monitors must register the MP feed in WeRSS up front. From a product
  // perspective, "保存监控成功" must mean the external source is actually ready;
  // otherwise the admin list can show a misleading local monitor that WeRSS
  // never subscribed. Keyword rules are local DB rules over already-collected
  // WeChat articles, so they deliberately skip WeRSS subscription.
  let cursor: Record<string, unknown> = {};
  let normalizedConfig = parsed.data as Record<string, unknown>;
  let resolvedWechatName: string | undefined;
  if (platform === "wechat" && !isWechatKeywordRuleConfig(parsed.data)) {
    try {
      const feed = await (await createRuntimeWeRssConnector()).subscribe((parsed.data as Extract<WechatMonitorConfig, { kind: "account" }>).articleUrl);
      cursor = { mpId: feed.mpId };
      resolvedWechatName = usefulWechatName(feed.mpName);
      normalizedConfig = {
        ...normalizedConfig,
        mpId: feed.mpId,
        ...(feed.mpBiz ? { mpBiz: feed.mpBiz } : {}),
        ...(feed.mpCover ? { mpCover: feed.mpCover } : {}),
        ...(feed.mpIntro ? { mpIntro: feed.mpIntro } : {}),
        ...(resolvedWechatName ? { mpName: resolvedWechatName } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[monitors] WeRSS 订阅失败: ${message}`);
      return NextResponse.json(
        {
          ok: false,
          error: "WeRSS 订阅失败，请检查 Access Key / 扫码授权后重试。",
          detail: message,
        },
        { status: 502 },
      );
    }
  }

  const monitorName =
    (name ?? "").trim() ||
    resolvedWechatName ||
    defaultName(platform as SupportedPlatform, normalizedConfig);
  const [row] = await db
    .insert(monitors)
    .values({
      platform: platform as PlatformType,
      connectorId,
      name: monitorName,
      config: normalizedConfig,
      cursor,
      pollIntervalMinutes: pollIntervalMinutes && pollIntervalMinutes > 0 ? pollIntervalMinutes : 30,
    })
    .returning();

  return NextResponse.json({ ok: true, monitor: row }, { status: 201 });
}
