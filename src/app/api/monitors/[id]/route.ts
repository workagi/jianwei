import { NextResponse } from "next/server";
import { db } from "@/db";
import { items, itemMatches, monitors } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import {
  xMonitorSchema,
  wechatMonitorSchema,
  webSearchMonitorSchema,
  isWechatKeywordRuleConfig,
} from "@/connectors/types";
import { createRuntimeWeRssConnector } from "@/connectors/factory";
import { requireWriteAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Only the three direct-connector platforms are editable through this API.
// TrendRadar is a system-managed sidecar source: SignalDeck stores a seed row
// so the worker can import its feed, but users must not edit/delete it here.
const SCHEMA_MAP = {
  x: xMonitorSchema,
  wechat: wechatMonitorSchema,
  web_search: webSearchMonitorSchema,
} as const;

type SupportedPlatform = keyof typeof SCHEMA_MAP;

function usefulWechatName(name: string | undefined): string | undefined {
  const trimmed = name?.trim();
  return trimmed && trimmed !== "未知公众号" ? trimmed : undefined;
}

function isAutoWechatName(name: string): boolean {
  return name === "微信公众号" || name === "mp.weixin.qq.com";
}

/**
 * Delete a single monitor. Cascade rules on `item_matches.monitor_id` and
 * `collection_runs.monitor_id` clean up its links/runs automatically. After
 * that, remove orphan items for the same platform so deleting a monitor also
 * removes content that no remaining monitor owns.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ ok: false, error: "DATABASE_URL 未配置" }, { status: 503 });
  }

  const denied = requireWriteAuth(_req);
  if (denied) return denied;

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ ok: false, error: "缺少监控 id" }, { status: 400 });
  }

  const [existing] = await db
    .select({ id: monitors.id, platform: monitors.platform })
    .from(monitors)
    .where(eq(monitors.id, id))
    .limit(1);

  if (!existing) {
    return NextResponse.json({ ok: false, error: "监控不存在" }, { status: 404 });
  }

  if (!(existing.platform in SCHEMA_MAP)) {
    return NextResponse.json(
      { ok: false, error: "系统内置监控不能在这里删除；请到对应侧车配置中管理。" },
      { status: 400 },
    );
  }

  const [deleted] = await db
    .delete(monitors)
    .where(eq(monitors.id, id))
    .returning({ id: monitors.id });

  await db.execute(sql`
    delete from ${items}
    where ${items.platform} = ${existing.platform}
      and not exists (
        select 1
        from ${itemMatches}
        where ${itemMatches.itemId} = ${items.id}
      )
  `);

  return NextResponse.json({ ok: true, id: deleted.id });
}

/**
 * Patch a single monitor: update `name` / `pollIntervalMinutes` / `config`.
 * `platform` cannot be changed (the connector + collected history are tied to
 * it). Config is re-validated against the monitor's existing platform schema.
 * For WeChat, changing the article URL re-subscribes the new MP in WeRSS and
 * rewrites the cursor. After any change we reset `nextRunAt` so the new config
 * is picked up on the next worker poll rather than waiting out the old schedule.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ ok: false, error: "DATABASE_URL 未配置" }, { status: 503 });
  }

  const denied = requireWriteAuth(req);
  if (denied) return denied;

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ ok: false, error: "缺少监控 id" }, { status: 400 });
  }

  const [existing] = await db
    .select()
    .from(monitors)
    .where(eq(monitors.id, id))
    .limit(1);
  if (!existing) {
    return NextResponse.json({ ok: false, error: "监控不存在" }, { status: 404 });
  }

  let body: { name?: string; pollIntervalMinutes?: number; config?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "无效的 JSON 请求体" }, { status: 400 });
  }

  const platform = existing.platform as SupportedPlatform;
  if (!(platform in SCHEMA_MAP)) {
    return NextResponse.json({ ok: false, error: `不支持的平台: ${platform}` }, { status: 400 });
  }

  const update: Record<string, unknown> = {
    updatedAt: new Date(),
    nextRunAt: new Date(),
  };

  if (typeof body.pollIntervalMinutes === "number") {
    if (!Number.isFinite(body.pollIntervalMinutes) || body.pollIntervalMinutes < 1) {
      return NextResponse.json({ ok: false, error: "采集频率必须为大于 0 的整数（分钟）" }, { status: 422 });
    }
    update.pollIntervalMinutes = Math.floor(body.pollIntervalMinutes);
  }

  if (typeof body.name === "string" && body.name.trim()) {
    update.name = body.name.trim();
  }

  if (body.config !== undefined) {
    const parsed = SCHEMA_MAP[platform].safeParse(body.config);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "配置校验失败", detail: parsed.error.flatten() },
        { status: 422 },
      );
    }

    if (platform === "wechat" && isWechatKeywordRuleConfig(parsed.data)) {
      update.config = parsed.data;
      update.cursor = {};
    } else if (platform === "wechat") {
      const prevUrl = (existing.config as { articleUrl?: string } | null)?.articleUrl;
      const nextUrl = (parsed.data as { articleUrl?: string }).articleUrl;
      if (nextUrl && nextUrl !== prevUrl) {
        try {
          const feed = await (await createRuntimeWeRssConnector()).subscribe(nextUrl);
          const mpName = usefulWechatName(feed.mpName);
          update.cursor = { mpId: feed.mpId };
          update.config = {
            ...(parsed.data as Record<string, unknown>),
            mpId: feed.mpId,
            ...(feed.mpBiz ? { mpBiz: feed.mpBiz } : {}),
            ...(feed.mpCover ? { mpCover: feed.mpCover } : {}),
            ...(feed.mpIntro ? { mpIntro: feed.mpIntro } : {}),
            ...(mpName ? { mpName } : {}),
          };
          if (!body.name?.trim() && isAutoWechatName(existing.name) && mpName) {
            update.name = mpName;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[monitors] WeRSS 重新订阅失败: ${message}`);
          return NextResponse.json(
            {
              ok: false,
              error: "WeRSS 重新订阅失败，请检查 Access Key / 扫码授权后重试。",
              detail: message,
            },
            { status: 502 },
          );
        }
      } else {
        update.config = {
          ...((existing.config ?? {}) as Record<string, unknown>),
          ...(parsed.data as Record<string, unknown>),
        };
      }
    }

    if (update.config === undefined) update.config = parsed.data;
  }

  const [row] = await db
    .update(monitors)
    .set(update)
    .where(eq(monitors.id, id))
    .returning({ id: monitors.id });

  return NextResponse.json({ ok: true, id: row.id });
}
