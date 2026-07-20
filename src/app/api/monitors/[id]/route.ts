import { NextResponse } from "next/server";
import { db } from "@/db";
import { items, itemMatches, monitors } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import {
  xMonitorSchema,
  wechatMonitorSchema,
  webSearchMonitorSchema,
  isWechatKeywordRuleConfig,
  type WechatAccountMonitorConfig,
} from "@/connectors/types";
import { createRuntimeWeRssConnector } from "@/connectors/factory";
import type { ResolvedFeed } from "@/connectors/wechat/werss-connector";
import { requireWriteAuth } from "@/lib/auth";
import {
  initialStaggeredRunAt,
  monitorStaggerKey,
  normalizePollIntervalMinutes,
} from "@/lib/monitor-schedule";
import { archiveMonitorConfig, parseMonitorRemovalOptions } from "@/lib/monitor-removal";

export const dynamic = "force-dynamic";

// Only the three direct-connector platforms are editable through this API.
// TrendRadar is a system-managed sidecar source: 见微 stores a seed row
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
  return name === "微信公众号" || name === "微信公众号识别中" || name === "mp.weixin.qq.com";
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

function monitorWechatMpId(row: { config: Record<string, unknown> | null; cursor: Record<string, unknown> | null }): string | undefined {
  const config = row.config ?? {};
  if (isWechatKeywordRuleConfig(config)) return undefined;
  const cursorMpId = typeof row.cursor?.mpId === "string" ? row.cursor.mpId.trim() : "";
  if (cursorMpId) return cursorMpId;
  const configMpId = typeof config.mpId === "string" ? config.mpId.trim() : "";
  return configMpId || undefined;
}

/**
 * Remove a monitor from the active task list.
 *
 * Safe default: archive it (disable + hide) while retaining item matches, so
 * historical content stays visible. Only `deleteItems=1` performs a hard
 * delete and removes content no other monitor owns.
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ ok: false, error: "DATABASE_URL 未配置" }, { status: 503 });
  }

  const denied = await requireWriteAuth(req);
  if (denied) return denied;
  const { cancelWerss, deleteItems } = parseMonitorRemovalOptions(req.url);

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ ok: false, error: "缺少监控 id" }, { status: 400 });
  }

  const [existing] = await db
    .select({ id: monitors.id, platform: monitors.platform, config: monitors.config, cursor: monitors.cursor })
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

  if (cancelWerss) {
    if (existing.platform !== "wechat") {
      return NextResponse.json({ ok: false, error: "只有微信公众号监控支持同时取消 WeRSS 订阅。" }, { status: 400 });
    }
    const mpId = monitorWechatMpId(existing);
    if (!mpId) {
      return NextResponse.json(
        { ok: false, error: "该监控还没有识别出公众号 ID，无法取消 WeRSS 订阅；可先只删除本地监控。" },
        { status: 422 },
      );
    }
    const wechatRows = await db
      .select({ id: monitors.id, config: monitors.config, cursor: monitors.cursor })
      .from(monitors)
      .where(eq(monitors.platform, "wechat"));
    const stillUsed = wechatRows.some((row) => row.id !== existing.id && monitorWechatMpId(row) === mpId);
    if (stillUsed) {
      return NextResponse.json(
        { ok: false, error: "还有其他监控任务使用同一个公众号，不能同时取消 WeRSS 订阅。" },
        { status: 409 },
      );
    }
    try {
      await (await createRuntimeWeRssConnector()).unsubscribe(mpId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[monitors] WeRSS 取消订阅失败: ${message}`);
      return NextResponse.json(
        { ok: false, error: "WeRSS 取消订阅失败；本地监控尚未删除。", detail: message },
        { status: 502 },
      );
    }
  }

  if (!deleteItems) {
    const archivedAt = new Date();
    const [archived] = await db
      .update(monitors)
      .set({
        enabled: false,
        config: archiveMonitorConfig(existing.config, archivedAt),
        updatedAt: archivedAt,
      })
      .where(eq(monitors.id, id))
      .returning({ id: monitors.id });
    return NextResponse.json({ ok: true, id: archived.id, mode: "archived", historyKept: true });
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

  return NextResponse.json({ ok: true, id: deleted.id, mode: "deleted", historyKept: false });
}

/**
 * Patch a single monitor: update `name` / `pollIntervalMinutes` / `config`.
 * `platform` cannot be changed (the connector + collected history are tied to
 * it). Config is re-validated against the monitor's existing platform schema.
 * For WeChat, changing the article URL re-subscribes the new MP in WeRSS and
 * rewrites the cursor. After any change we reset `nextRunAt` into the smart
 * stagger window so fresh edits are picked up soon without stampeding WeRSS.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ ok: false, error: "DATABASE_URL 未配置" }, { status: 503 });
  }

  const denied = await requireWriteAuth(req);
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
  };

  if (typeof body.pollIntervalMinutes === "number") {
    if (!Number.isFinite(body.pollIntervalMinutes) || body.pollIntervalMinutes < 1) {
      return NextResponse.json({ ok: false, error: "采集频率必须为大于 0 的整数（分钟）" }, { status: 422 });
    }
    update.pollIntervalMinutes = normalizePollIntervalMinutes(body.pollIntervalMinutes, existing.pollIntervalMinutes);
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
      const nextConfig = parsed.data as WechatAccountMonitorConfig;
      const nextUrl = nextConfig.articleUrl;
      if (nextUrl && nextUrl !== prevUrl) {
        const resolvedFeed = resolvedFeedFromWechatConfig(nextConfig);
        if (resolvedFeed === null) {
          // Keep editing consistent with creation: changing to a fresh article URL
          // should not block the form on the slow WeRSS by_article resolver.
          // The worker will resolve+subscribe in the background on the next run.
          update.cursor = {};
          update.config = parsed.data;
          if (!body.name?.trim() && isAutoWechatName(existing.name)) {
            update.name = "微信公众号识别中";
          }
        } else {
          try {
            const connector = await createRuntimeWeRssConnector();
            const feed = await connector.subscribeResolved(resolvedFeed);
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

  const nextName = typeof update.name === "string" ? update.name : existing.name;
  const nextConfig = update.config === undefined ? existing.config : update.config;
  const nextPollIntervalMinutes =
    typeof update.pollIntervalMinutes === "number" ? update.pollIntervalMinutes : existing.pollIntervalMinutes;
  update.nextRunAt = initialStaggeredRunAt({
    intervalMinutes: nextPollIntervalMinutes,
    staggerKey: monitorStaggerKey({
      id: existing.id,
      platform,
      name: nextName,
      config: nextConfig,
    }),
  });

  const [row] = await db
    .update(monitors)
    .set(update)
    .where(eq(monitors.id, id))
    .returning({ id: monitors.id });

  return NextResponse.json({ ok: true, id: row.id });
}
