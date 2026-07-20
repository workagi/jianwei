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
  type WechatAccountMonitorConfig,
  type WechatMonitorConfig,
} from "@/connectors/types";
import { createRuntimeWeRssConnector } from "@/connectors/factory";
import type { ResolvedFeed } from "@/connectors/wechat/werss-connector";
import { requireWriteAuth } from "@/lib/auth";
import {
  initialStaggeredRunAt,
  monitorStaggerKey,
  normalizePollIntervalMinutes,
} from "@/lib/monitor-schedule";

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
    return mpName || "微信公众号识别中";
  }
  return (config.query as string) ?? "全网监控";
}

function usefulWechatName(name: string | undefined): string | undefined {
  const trimmed = name?.trim();
  return trimmed && trimmed !== "未知公众号" ? trimmed : undefined;
}

function resolvedFeedFromWechatConfig(config: WechatAccountMonitorConfig): ResolvedFeed | null {
  if (!config.mpId || !config.mpBiz) return null;
  return {
    mpId: config.mpId,
    mpName: usefulWechatName(config.mpName) ?? "微信公众号",
    mpBiz: config.mpBiz,
    mpCover: config.mpCover,
    mpIntro: config.mpIntro,
  };
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

  const denied = await requireWriteAuth(req);
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
  if (pollIntervalMinutes !== undefined && (!Number.isFinite(pollIntervalMinutes) || pollIntervalMinutes < 1)) {
    return NextResponse.json({ ok: false, error: "采集频率必须为大于 0 的整数（分钟）" }, { status: 422 });
  }
  const normalizedPollIntervalMinutes = normalizePollIntervalMinutes(pollIntervalMinutes, 30);

  const connectorId = connectorIdForPlatform(platform as PlatformType);
  if (!connectorId) {
    return NextResponse.json({ ok: false, error: "连接器未初始化，请先运行 `pnpm db:seed`" }, { status: 500 });
  }

  // WeChat account monitors can be created in two ways:
  // - after preview: config already contains mpId/mpBiz, so saving can subscribe
  //   quickly without re-running the slow by_article resolver;
  // - without preview: create the local monitor immediately and let the worker
  //   perform the slow resolve+subscribe in the background on its first run.
  // Keyword rules are local DB rules over already-collected WeChat articles.
  let cursor: Record<string, unknown> = {};
  let normalizedConfig = parsed.data as Record<string, unknown>;
  let resolvedWechatName: string | undefined;
  if (platform === "wechat" && !isWechatKeywordRuleConfig(parsed.data)) {
    const config = parsed.data as Extract<WechatMonitorConfig, { kind: "account" }>;
    const resolvedFeed = resolvedFeedFromWechatConfig(config);
    if (resolvedFeed !== null) {
      try {
        const feed = await (await createRuntimeWeRssConnector()).subscribeResolved(resolvedFeed);
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
  }

  const monitorName =
    (name ?? "").trim() ||
    resolvedWechatName ||
    defaultName(platform as SupportedPlatform, normalizedConfig);
  const staggerKey = monitorStaggerKey({
    platform,
    name: monitorName,
    config: normalizedConfig,
  });
  const [row] = await db
    .insert(monitors)
    .values({
      platform: platform as PlatformType,
      connectorId,
      name: monitorName,
      config: normalizedConfig,
      cursor,
      pollIntervalMinutes: normalizedPollIntervalMinutes,
      nextRunAt: initialStaggeredRunAt({
        intervalMinutes: normalizedPollIntervalMinutes,
        staggerKey,
      }),
    })
    .returning();

  return NextResponse.json({ ok: true, monitor: row }, { status: 201 });
}
