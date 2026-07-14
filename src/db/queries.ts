import { db } from "./index";
import { items, itemMatches, monitors, connectors, apiCredentials } from "./schema";
import { desc, eq, and, gte, sql, type SQL } from "drizzle-orm";
import type { PlatformType } from "@/connectors/types";

export interface ItemFilter {
  platform?: PlatformType;
  search?: string;
  monitorId?: string;
  since?: Date;
  limit?: number;
  offset?: number;
}

/**
 * Read the unified item feed. All connectors (direct + TrendRadar) land in the
 * same `items` table, so the reader only needs one query with optional
 * platform / keyword / time filters.
 */
export async function getItems(filter: ItemFilter = {}) {
  const conditions: SQL[] = [
    sql`exists (
      select 1
      from ${itemMatches}
      where ${itemMatches.itemId} = ${items.id}
    )`,
  ];
  if (filter.platform) conditions.push(eq(items.platform, filter.platform));
  if (filter.monitorId) {
    conditions.push(sql`exists (
      select 1
      from ${itemMatches}
      where ${itemMatches.itemId} = ${items.id}
        and ${itemMatches.monitorId} = ${filter.monitorId}
    )`);
  }
  if (filter.search) {
    const term = `%${filter.search}%`;
    conditions.push(
      sql`(${items.title} ilike ${term} or ${items.bodyText} ilike ${term} or ${items.authorName} ilike ${term})`,
    );
  }
  if (filter.since) conditions.push(gte(items.publishedAt, filter.since));

  return db
    .select({
      id: items.id,
      platform: items.platform,
      upstreamId: items.upstreamId,
      canonicalUrl: items.canonicalUrl,
      authorId: items.authorId,
      authorName: items.authorName,
      authorHandle: items.authorHandle,
      title: items.title,
      bodyText: items.bodyText,
      aiSummary: items.aiSummary,
      contentType: items.contentType,
      topicTags: items.topicTags,
      contentHtml: items.contentHtml,
      imageUrls: items.imageUrls,
      publishedAt: items.publishedAt,
      fetchedAt: items.fetchedAt,
      contentHash: items.contentHash,
      createdAt: items.createdAt,
      updatedAt: items.updatedAt,
      matchReason: sql<string | null>`(
        select case when count(*) > 0 then '命中：' || string_agg(m.name, '、') else null end
        from item_matches im
        join monitors m on m.id = im.monitor_id
        where im.item_id = ${items.id}
          and m.platform = 'wechat'
          and m.config->>'kind' = 'keyword_rule'
      )`,
    })
    .from(items)
    .where(conditions.length ? and(...conditions)! : sql`1=1`)
    .orderBy(desc(items.publishedAt))
    .limit(filter.limit ?? 50)
    .offset(filter.offset ?? 0);
}

export async function getWechatKeywordRuleFilters() {
  return db
    .select({
      id: monitors.id,
      name: monitors.name,
      itemCount: sql<number>`(
        select count(*)::int
        from item_matches im
        where im.monitor_id = ${monitors.id}
      )`,
    })
    .from(monitors)
    .where(and(
      eq(monitors.platform, "wechat"),
      eq(monitors.enabled, true),
      sql`${monitors.config}->>'kind' = 'keyword_rule'`,
    ))
    .orderBy(desc(monitors.updatedAt));
}

export async function getMonitorsWithHealth() {
  return db
    .select({
      id: monitors.id,
      platform: monitors.platform,
      name: monitors.name,
      enabled: monitors.enabled,
      config: monitors.config,
      pollIntervalMinutes: monitors.pollIntervalMinutes,
      lastSuccessAt: monitors.lastSuccessAt,
      nextRunAt: monitors.nextRunAt,
      failureCount: monitors.failureCount,
      lastError: monitors.lastError,
      healthStatus: connectors.healthStatus,
      itemCount: sql<number>`(
        select count(*)::int
        from item_matches im
        where im.monitor_id = ${monitors.id}
      )`,
      latestRunStatus: sql<string | null>`(
        select cr.status::text
        from collection_runs cr
        where cr.monitor_id = ${monitors.id}
        order by cr.started_at desc
        limit 1
      )`,
      latestRunStartedAt: sql<Date | null>`(
        select cr.started_at
        from collection_runs cr
        where cr.monitor_id = ${monitors.id}
        order by cr.started_at desc
        limit 1
      )`,
      latestRunFinishedAt: sql<Date | null>`(
        select cr.finished_at
        from collection_runs cr
        where cr.monitor_id = ${monitors.id}
        order by cr.started_at desc
        limit 1
      )`,
      latestRunFetchedCount: sql<number | null>`(
        select cr.fetched_count
        from collection_runs cr
        where cr.monitor_id = ${monitors.id}
        order by cr.started_at desc
        limit 1
      )`,
      latestRunErrorCode: sql<string | null>`(
        select cr.error_code
        from collection_runs cr
        where cr.monitor_id = ${monitors.id}
        order by cr.started_at desc
        limit 1
      )`,
      latestRunErrorMessage: sql<string | null>`(
        select cr.error_message
        from collection_runs cr
        where cr.monitor_id = ${monitors.id}
        order by cr.started_at desc
        limit 1
      )`,
      latestSummaryStatus: sql<string | null>`(
        select cr.summary_status
        from collection_runs cr
        where cr.monitor_id = ${monitors.id}
        order by cr.started_at desc
        limit 1
      )`,
      latestSummaryAttemptedCount: sql<number | null>`(
        select cr.summary_attempted_count
        from collection_runs cr
        where cr.monitor_id = ${monitors.id}
        order by cr.started_at desc
        limit 1
      )`,
      latestSummarySucceededCount: sql<number | null>`(
        select cr.summary_succeeded_count
        from collection_runs cr
        where cr.monitor_id = ${monitors.id}
        order by cr.started_at desc
        limit 1
      )`,
      latestSummaryErrorCode: sql<string | null>`(
        select cr.summary_error_code
        from collection_runs cr
        where cr.monitor_id = ${monitors.id}
        order by cr.started_at desc
        limit 1
      )`,
    })
    .from(monitors)
    .leftJoin(connectors, eq(monitors.connectorId, connectors.id))
    .orderBy(desc(monitors.updatedAt));
}

export async function getConnectors() {
  return db.select().from(connectors).orderBy(connectors.platform);
}

// ---------------------------------------------------------------------------
// API 凭据（在后台界面配置，存库后由 worker 每轮刷新到 process.env）
// ---------------------------------------------------------------------------

/** 读取全部凭据（含明文 value）。仅服务端内部使用，切勿返回到前端。 */
export async function loadApiCredentials(): Promise<{ key: string; value: string }[]> {
  return db
    .select({ key: apiCredentials.key, value: apiCredentials.value })
    .from(apiCredentials);
}

/** 批量 upsert 凭据。只写入调用方提供的非空项。 */
export async function saveApiCredentials(rows: { key: string; value: string }[]): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(apiCredentials)
    .values(rows.map((r) => ({ key: r.key, value: r.value, updatedAt: new Date() })))
    .onConflictDoUpdate({
      target: apiCredentials.key,
      set: { value: sql`excluded.value`, updatedAt: new Date() },
    });
}
