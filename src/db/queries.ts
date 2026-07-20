import { db } from "./index";
import { items, itemMatches, monitors, connectors, apiCredentials, bookmarks, collectionRuns } from "./schema";
import { desc, eq, and, gte, inArray, sql, type SQL } from "drizzle-orm";
import type { PlatformType } from "@/connectors/types";
import { decryptCredential, encryptCredential, isEncryptedCredential } from "@/lib/credential-crypto";

export interface ItemFilter {
  platform?: PlatformType;
  search?: string;
  monitorId?: string;
  since?: Date;
  bookmarkedOnly?: boolean;
  limit?: number;
  offset?: number;
}

function itemConditions(filter: ItemFilter): SQL[] {
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
      sql`(${items.title} ilike ${term} or ${items.translatedTitle} ilike ${term} or ${items.bodyText} ilike ${term} or ${items.authorName} ilike ${term})`,
    );
  }
  if (filter.since) conditions.push(gte(items.publishedAt, filter.since));
  if (filter.bookmarkedOnly) {
    conditions.push(sql`exists (
      select 1 from ${bookmarks} where ${bookmarks.itemId} = ${items.id}
    )`);
  }
  return conditions;
}

/**
 * Read the unified item feed. All connectors (direct + TrendRadar) land in the
 * same `items` table, so the reader only needs one query with optional
 * platform / keyword / time filters.
 */
export async function getItems(filter: ItemFilter = {}) {
  const conditions = itemConditions(filter);

  return db
    .select({
      id: items.id,
      platform: items.platform,
      sourceProvider: items.sourceProvider,
      upstreamId: items.upstreamId,
      canonicalUrl: items.canonicalUrl,
      authorId: items.authorId,
      authorName: items.authorName,
      authorHandle: items.authorHandle,
      avatarUrl: sql<string | null>`coalesce(
        ${items.avatarUrl},
        (
          select recent_avatar.avatar_url
          from items recent_avatar
          where recent_avatar.platform = 'x'
            and recent_avatar.author_handle = ${items.authorHandle}
            and nullif(btrim(recent_avatar.avatar_url), '') is not null
          order by recent_avatar.fetched_at desc
          limit 1
        )
      )`,
      title: items.title,
      translatedTitle: items.translatedTitle,
      bodyText: items.bodyText,
      aiSummary: items.aiSummary,
      contentType: items.contentType,
      topicTags: items.topicTags,
      retentionReason: items.retentionReason,
      relevanceScore: items.relevanceScore,
      retentionSource: items.retentionSource,
      contentHtml: items.contentHtml,
      contentProvider: items.contentProvider,
      contentFetchStatus: items.contentFetchStatus,
      contentFetchError: items.contentFetchError,
      contentFetchedAt: items.contentFetchedAt,
      imageUrls: items.imageUrls,
      publishedAt: items.publishedAt,
      fetchedAt: items.fetchedAt,
      contentHash: items.contentHash,
      createdAt: items.createdAt,
      updatedAt: items.updatedAt,
      bookmarked: sql<boolean>`exists (
        select 1 from ${bookmarks} where ${bookmarks.itemId} = ${items.id}
      )`,
      matchReason: sql<string | null>`(
        select string_agg(distinct case
          when m.platform = 'wechat' and m.config->>'kind' = 'keyword_rule' then '公众号关键词：' || m.name
          when m.platform = 'wechat' then '订阅公众号：' || m.name
          when m.platform = 'x' then '订阅账号：' || m.name
          when m.platform = 'web_search' then '搜索任务：' || m.name
          when m.platform = 'trendradar' then '热榜兴趣规则'
          else '监控任务：' || m.name
        end, ' · ')
        from item_matches im
        join monitors m on m.id = im.monitor_id
        where im.item_id = ${items.id}
      )`,
    })
    .from(items)
    .where(conditions.length ? and(...conditions)! : sql`1=1`)
    .orderBy(desc(items.publishedAt))
    .limit(filter.limit ?? 50)
    .offset(filter.offset ?? 0);
}

/** Exact count before reader-only quality/type/topic filters are applied. */
export async function countItems(filter: Omit<ItemFilter, "limit" | "offset"> = {}): Promise<number> {
  const conditions = itemConditions(filter);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(items)
    .where(conditions.length ? and(...conditions)! : sql`1=1`);
  return Number(row?.count ?? 0);
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
    .where(sql`not (${monitors.config} ? '_archivedAt')`)
    .orderBy(desc(monitors.updatedAt));
}

export async function getConnectors() {
  return db.select().from(connectors).orderBy(connectors.platform);
}

/**
 * Aggregate the content-processing pipeline from data that is still connected
 * to at least one monitor. This keeps the dashboard aligned with the reader and
 * avoids counting orphaned rows left behind after a monitor is deleted.
 */
export async function getContentPipelineStats() {
  const activeItem = sql`exists (
    select 1
    from ${itemMatches}
    where ${itemMatches.itemId} = ${items.id}
  )`;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [platforms, newItemsRows, runRows] = await Promise.all([
    db
      .select({
        platform: items.platform,
        total: sql<number>`count(*)::int`,
        withSummary: sql<number>`coalesce(sum(case when nullif(btrim(${items.aiSummary}), '') is not null then 1 else 0 end), 0)::int`,
        structured: sql<number>`coalesce(sum(case when nullif(btrim(${items.contentType}), '') is not null and jsonb_array_length(${items.topicTags}) > 0 then 1 else 0 end), 0)::int`,
        analysisReady: sql<number>`coalesce(sum(case when ${items.analysisStatus} in ('success', 'partial') then 1 else 0 end), 0)::int`,
        analysisFailed: sql<number>`coalesce(sum(case when ${items.analysisStatus} = 'failed' then 1 else 0 end), 0)::int`,
        explained: sql<number>`coalesce(sum(case when ${items.retentionSource} = 'model' and nullif(btrim(${items.retentionReason}), '') is not null and ${items.relevanceScore} is not null then 1 else 0 end), 0)::int`,
        withFullText: sql<number>`coalesce(sum(case when nullif(btrim(${items.contentHtml}), '') is not null then 1 else 0 end), 0)::int`,
        fallbackFullText: sql<number>`coalesce(sum(case when nullif(btrim(${items.contentHtml}), '') is not null and ${items.contentProvider} in ('direct', 'wechat_download_api') then 1 else 0 end), 0)::int`,
        fullTextFailed: sql<number>`coalesce(sum(case when ${items.contentFetchStatus} = 'failed' then 1 else 0 end), 0)::int`,
      })
      .from(items)
      .where(activeItem)
      .groupBy(items.platform),
    db
      .select({
        count: sql<number>`count(*)::int`,
      })
      .from(items)
      .where(and(activeItem, gte(items.createdAt, since))),
    db
      .select({
        runs24h: sql<number>`count(*)::int`,
        failedRuns24h: sql<number>`coalesce(sum(case when ${collectionRuns.status} = 'failed' then 1 else 0 end), 0)::int`,
        partialRuns24h: sql<number>`coalesce(sum(case when ${collectionRuns.status} = 'partial' then 1 else 0 end), 0)::int`,
        summaryAttempted24h: sql<number>`coalesce(sum(${collectionRuns.summaryAttemptedCount}), 0)::int`,
        summarySucceeded24h: sql<number>`coalesce(sum(${collectionRuns.summarySucceededCount}), 0)::int`,
        summaryFailed24h: sql<number>`coalesce(sum(${collectionRuns.summaryFailedCount}), 0)::int`,
        modelEstimatedCost24h: sql<number>`coalesce(sum(${collectionRuns.providerCost}), 0)`,
        lastRunAt: sql<Date | null>`max(${collectionRuns.startedAt})`,
      })
      .from(collectionRuns)
      .where(gte(collectionRuns.startedAt, since)),
  ]);

  const runs = runRows[0];
  return {
    platforms,
    recent: {
      runs24h: Number(runs?.runs24h ?? 0),
      failedRuns24h: Number(runs?.failedRuns24h ?? 0),
      partialRuns24h: Number(runs?.partialRuns24h ?? 0),
      summaryAttempted24h: Number(runs?.summaryAttempted24h ?? 0),
      summarySucceeded24h: Number(runs?.summarySucceeded24h ?? 0),
      summaryFailed24h: Number(runs?.summaryFailed24h ?? 0),
      modelEstimatedCost24h: Number(runs?.modelEstimatedCost24h ?? 0),
      newItems24h: Number(newItemsRows[0]?.count ?? 0),
      lastRunAt: runs?.lastRunAt ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// API 凭据（在后台界面配置，存库后由 worker 每轮刷新到 process.env）
// ---------------------------------------------------------------------------

/** 读取全部凭据。旧的明文行会在首次读取时原地升级为 AES-256-GCM 密文。 */
export async function loadApiCredentials(): Promise<{ key: string; value: string }[]> {
  const stored = await db
    .select({ key: apiCredentials.key, value: apiCredentials.value })
    .from(apiCredentials);
  const rows = stored.map((row) => ({ key: row.key, value: decryptCredential(row.value) }));
  const legacyRows = stored.filter((row) => !isEncryptedCredential(row.value));
  if (legacyRows.length > 0) {
    await saveApiCredentials(rows.filter((row) => legacyRows.some((legacy) => legacy.key === row.key)));
  }
  return rows;
}

/** 批量 upsert 凭据。只写入调用方提供的非空项。 */
export async function saveApiCredentials(rows: { key: string; value: string }[]): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(apiCredentials)
    .values(rows.map((r) => ({ key: r.key, value: encryptCredential(r.value), updatedAt: new Date() })))
    .onConflictDoUpdate({
      target: apiCredentials.key,
      set: { value: sql`excluded.value`, updatedAt: new Date() },
    });
}

/** 删除指定凭据；用于 OAuth 取消授权和清理一次性设备码。 */
export async function deleteApiCredentials(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await db.delete(apiCredentials).where(inArray(apiCredentials.key, keys));
}
