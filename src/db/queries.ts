import { db } from "./index";
import { items, itemMatches, sourceItems, monitors, connectors, apiCredentials, bookmarks, collectionRuns, eventItems, contentEvents, eventReaderStates } from "./schema";
import { loginAttempts } from "./schema";
import { asc, desc, eq, and, gt, gte, inArray, sql, type SQL } from "drizzle-orm";
import { CONTENT_TYPE_FILTERS } from "@/lib/item-tags";
import { automaticAnalysisCondition } from "./analysis-queue";
import type { PlatformType } from "@/connectors/types";
import { decryptCredential, encryptCredential, isEncryptedCredential } from "@/lib/credential-crypto";

export interface ItemFilter {
  platform?: PlatformType;
  search?: string;
  monitorId?: string;
  monitorIds?: string[];
  since?: Date;
  bookmarkedOnly?: boolean;
  featuredOnly?: boolean;
  changesOnly?: boolean;
  followedOnly?: boolean;
  limit?: number;
  offset?: number;
  eventIds?: string[];
  itemIds?: string[];
}

function selectedMonitors(filter: ItemFilter): string[] {
  return filter.monitorIds?.length ? filter.monitorIds : filter.monitorId ? [filter.monitorId] : [];
}

function selectedMatchScope(filter: ItemFilter, alias: "im" | "selected_match" | "item_matches"): SQL {
  return and(inArray(sql`${sql.identifier(alias)}.monitor_id`, selectedMonitors(filter)),
    filter.platform ? sql`exists (select 1 from source_items scope_source
      where scope_source.id = ${sql.identifier(alias)}.source_item_id and scope_source.platform = ${filter.platform})` : undefined)!;
}

function featuredScore(filter: ItemFilter): SQL<number | null> {
  const selected = selectedMonitors(filter);
  return selected.length
    ? sql`(select max(im.relevance_score) from item_matches im where im.item_id = ${items.id} and ${selectedMatchScope(filter, "im")} and im.retention_status = 'kept')`
    : sql`${items.informationValueScore}`;
}

function itemConditions(filter: ItemFilter): SQL[] {
  const selected = selectedMonitors(filter);
  const conditions: SQL[] = [
    sql`exists (
      select 1
      from ${itemMatches}
      where ${itemMatches.itemId} = ${items.id}
        and ${itemMatches.retentionStatus} = 'kept'
    )`,
  ];
  if (filter.platform && selected.length) {
    // Both filters must describe the same observation. Checking them in two
    // independent EXISTS clauses would let a web-search monitor match one
    // source while the platform filter matched a different RSS source of the
    // same canonical document.
    conditions.push(sql`exists (
      select 1
      from ${itemMatches}
      inner join ${sourceItems} on ${sourceItems.id} = ${itemMatches.sourceItemId}
      where ${itemMatches.itemId} = ${items.id}
        and ${inArray(itemMatches.monitorId, selected)}
        and ${itemMatches.retentionStatus} = 'kept'
        and ${sourceItems.platform} = ${filter.platform}
    )`);
  } else if (filter.platform) {
    conditions.push(sql`exists (
      select 1 from ${sourceItems}
      where ${sourceItems.itemId} = ${items.id}
        and ${sourceItems.platform} = ${filter.platform}
    )`);
  } else if (selected.length) {
    conditions.push(sql`exists (
      select 1
      from ${itemMatches}
      where ${itemMatches.itemId} = ${items.id}
        and ${inArray(itemMatches.monitorId, selected)}
        and ${itemMatches.retentionStatus} = 'kept'
    )`);
  }
  if (filter.eventIds?.length) conditions.push(sql`exists (select 1 from event_items scoped_event
    where scoped_event.item_id = ${items.id} and ${inArray(sql`scoped_event.event_id`, filter.eventIds)})`);
  if (filter.itemIds?.length) conditions.push(inArray(items.id, filter.itemIds));
  if (filter.search) {
    const term = `%${filter.search}%`;
    conditions.push(
      sql`(${items.title} ilike ${term} or ${items.translatedTitle} ilike ${term} or ${items.bodyText} ilike ${term} or ${items.authorName} ilike ${term})`,
    );
  }
  if (filter.since) conditions.push(filter.changesOnly ? sql`
    coalesce((select ce.activity_at from event_items ei join content_events ce on ce.id = ei.event_id where ei.item_id = ${items.id}), ${items.publishedAt}) >= ${filter.since.toISOString()}::timestamptz
  ` : gte(items.publishedAt, filter.since));
  if (filter.featuredOnly) conditions.push(sql`
    ${featuredScore(filter)} >= 60
    and length(coalesce(${items.editorialReason}, case when ${items.retentionSource} = 'model' then ${items.retentionReason} end, '')) >= 12
    and length(coalesce(${items.aiSummary}, '')) >= 20
    and not exists (
      select 1 from event_items ei join content_events ce on ce.id = ei.event_id
      join event_developments d on d.event_id = ce.id and d.event_revision = ce.revision
      join items current_material on current_material.id = d.item_id
      where ei.item_id = ${items.id} and ce.revision > 1
        and current_material.analysis_status not in ('success', 'partial')
    )
  `);
  if (filter.changesOnly || filter.followedOnly) conditions.push(sql`exists (
    select 1 from event_items ei join content_events ce on ce.id = ei.event_id
    left join event_reader_states ers on ers.event_id = ce.id
    where ei.item_id = ${items.id}
    ${filter.changesOnly ? sql`and ce.revision > coalesce(ers.read_revision, 0)` : sql``}
    ${filter.followedOnly ? sql`and ers.followed = true` : sql``}
  )`);
  if (filter.bookmarkedOnly) {
    conditions.push(sql`exists (
      select 1 from ${bookmarks} where ${bookmarks.itemId} = ${items.id}
    )`);
  }
  return conditions;
}

function readerItemSelection(filter: ItemFilter) {
  const selected = selectedMonitors(filter);
  const selectedSource = db.select({ platform: sourceItems.platform, sourceProvider: sourceItems.sourceProvider, upstreamId: sourceItems.upstreamId, authorId: sourceItems.authorId, authorName: sourceItems.authorName, authorHandle: sourceItems.authorHandle, avatarUrl: sourceItems.avatarUrl }).from(sourceItems).where(and(
    eq(sourceItems.itemId, items.id),
    filter.platform ? eq(sourceItems.platform, filter.platform) : undefined,
    selected.length ? sql`exists (select 1 from item_matches selected_match
      where selected_match.source_item_id = ${sourceItems.id}
        and ${inArray(sql`selected_match.monitor_id`, selected)}
        and selected_match.retention_status = 'kept')` : undefined,
  )).orderBy(sql`case when ${sourceItems.platform} = ${items.platform} and ${sourceItems.upstreamId} = ${items.upstreamId} then 0 else 1 end`, sourceItems.firstSeenAt)
    .limit(1).as("selected_source");
  const selectedMatch = db.select({ score: itemMatches.relevanceScore, reason: itemMatches.retentionReason, source: itemMatches.retentionSource })
    .from(itemMatches).where(and(eq(itemMatches.itemId, items.id), eq(itemMatches.retentionStatus, "kept"),
      selected.length ? selectedMatchScope(filter, "item_matches") : sql`false`))
    .orderBy(sql`${itemMatches.relevanceScore} desc nulls last`, itemMatches.monitorId).limit(1).as("selected_match");
  const readerPlatform = sql<PlatformType>`coalesce(${selectedSource.platform}, ${items.platform})`;
  const score = sql<number | null>`coalesce(${selectedMatch.score}, ${items.informationValueScore}, ${items.relevanceScore})`;
  // Keep complete inputs where reader rules still need them. Classified long
  // articles only transfer a preview; SQL search still sees their full text.
  const needsRuleInput = sql`(${items.contentType} is null or ${items.contentType} not in ${CONTENT_TYPE_FILTERS.flatMap(type => [type.id, type.label])}
    or jsonb_array_length(coalesce(${items.topicTags}, '[]'::jsonb)) = 0 or ${score} is null)`;
  const fields = {
    id: items.id,
    platform: readerPlatform,
    authorName: sql<string | null>`coalesce(${selectedSource.authorName}, ${items.authorName})`,
    authorHandle: sql<string | null>`coalesce(${selectedSource.authorHandle}, ${items.authorHandle})`,
    title: items.title,
    translatedTitle: items.translatedTitle,
    bodyText: sql<string>`case when ${readerPlatform} in ('x', 'trendradar') or ${needsRuleInput}
      then ${items.bodyText} else left(${items.bodyText}, 320) end`,
    aiSummary: items.aiSummary,
    editorialReason: items.editorialReason,
    eventId: eventItems.eventId,
    eventDate: contentEvents.activityAt,
    eventRevision: contentEvents.revision,
    eventChange: contentEvents.latestChange,
    eventPreferredItemId: sql<string | null>`(select d.item_id from event_developments d
      where d.event_id = ${contentEvents.id} and d.event_revision = ${contentEvents.revision}
        and ${contentEvents.revision} > 1 limit 1)`,
    contentType: items.contentType,
    topicTags: items.topicTags,
    retentionReason: sql<string | null>`coalesce(${selectedMatch.reason}, ${items.retentionReason})`,
    relevanceScore: score,
    retentionSource: sql<string | null>`coalesce(${selectedMatch.source}, ${items.retentionSource})`,
    contentHtml: sql<string | null>`case when ${needsRuleInput} or left(btrim(${items.contentHtml}), 1) = '{'
      then ${items.contentHtml} else null end`,
    canonicalUrl: items.canonicalUrl,
    publishedAt: items.publishedAt,
  };
  return { selected, selectedSource, selectedMatch, fields };
}

/** Read full documents or the fields needed to display reader cards. */
export async function getItems(filter: ItemFilter = {}, projection: "full" | "reader" = "full") {
  const conditions = itemConditions(filter);
  const { selected, selectedSource, selectedMatch, fields } = readerItemSelection(filter);
  const query = db
    .select({
      ...fields,
      sourceProvider: sql<string | null>`coalesce(
        ${selectedSource.sourceProvider},
        ${items.sourceProvider}
      )`,
      upstreamId: sql<string>`coalesce(
        ${selectedSource.upstreamId},
        ${items.upstreamId}
      )`,
      authorId: sql<string | null>`coalesce(
        ${selectedSource.authorId},
        ${items.authorId}
      )`,
      avatarUrl: sql<string | null>`coalesce(
        ${selectedSource.avatarUrl},
        ${items.avatarUrl},
        case when ${items.authorHandle} is not null then (
          select recent_avatar.avatar_url
          from items recent_avatar
          where recent_avatar.platform = 'x'
            and recent_avatar.author_handle = ${items.authorHandle}
            and nullif(btrim(recent_avatar.avatar_url), '') is not null
          order by recent_avatar.fetched_at desc
          limit 1
        ) end
      )`,
      bodyText: projection === "full" ? items.bodyText : fields.bodyText,
      readRevision: eventReaderStates.readRevision,
      followed: eventReaderStates.followed,
      contentHtml: projection === "full" ? items.contentHtml : fields.contentHtml,
      hasFullText: sql<boolean>`nullif(btrim(${items.contentHtml}), '') is not null`,
      contentProvider: items.contentProvider,
      contentFetchStatus: items.contentFetchStatus,
      contentFetchError: items.contentFetchError,
      contentFetchedAt: items.contentFetchedAt,
      imageUrls: items.imageUrls,
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
          and im.retention_status = 'kept'
          ${selected.length ? sql`and ${selectedMatchScope(filter, "im")}` : sql``}
      )`,
    })
    .from(items)
    .leftJoinLateral(selectedSource, sql`true`)
    .leftJoinLateral(selectedMatch, sql`true`)
    .leftJoin(eventItems, eq(eventItems.itemId, items.id))
    .leftJoin(contentEvents, eq(contentEvents.id, eventItems.eventId))
    .leftJoin(eventReaderStates, eq(eventReaderStates.eventId, contentEvents.id))
    .where(conditions.length ? and(...conditions)! : sql`1=1`)
    .orderBy(...(filter.changesOnly || filter.followedOnly ? [desc(contentEvents.activityAt), desc(items.publishedAt)] : filter.featuredOnly ? [desc(featuredScore(filter)), desc(items.publishedAt)] : [desc(items.publishedAt)]))
    .offset(filter.offset ?? 0);
  return filter.eventIds?.length && filter.limit === undefined ? query : query.limit(filter.limit ?? 50);
}

export function getReaderItems(filter: ItemFilter = {}) {
  return getItems(filter, "reader");
}

/** Rank with reader inputs only; hydrate display fields after selecting the page. */
export function getReaderEventCandidates(filter: ItemFilter, limit: number, afterId?: string) {
  const window = db.select({ id: items.id }).from(items)
    .where(and(...itemConditions(filter), afterId ? gt(items.id, afterId) : undefined))
    .orderBy(asc(items.id)).limit(limit).as("member_window");
  const { selectedSource, selectedMatch, fields } = readerItemSelection(filter);
  return db.select(fields).from(window).innerJoin(items, eq(items.id, window.id))
    .leftJoinLateral(selectedSource, sql`true`)
    .leftJoinLateral(selectedMatch, sql`true`)
    .innerJoin(eventItems, eq(eventItems.itemId, items.id))
    .innerJoin(contentEvents, eq(contentEvents.id, eventItems.eventId))
    .orderBy(asc(items.id));
}

/** Page event identities before reading members: duplicates cannot consume the page. */
export async function getReaderEventIds(filter: ItemFilter, limit: number, offset: number) {
  return db.select({ id: contentEvents.id }).from(items)
    .innerJoin(eventItems, eq(eventItems.itemId, items.id))
    .innerJoin(contentEvents, eq(contentEvents.id, eventItems.eventId))
    .where(and(...itemConditions(filter)))
    .groupBy(contentEvents.id, contentEvents.activityAt)
    .orderBy(desc(contentEvents.activityAt), desc(contentEvents.id))
    .limit(limit).offset(offset);
}

export async function getReaderMonitorFilters(platform?: PlatformType) {
  return db.select({ id: monitors.id, name: monitors.name }).from(monitors)
    .where(and(eq(monitors.enabled, true), platform ? eq(monitors.platform, platform) : undefined)).orderBy(desc(monitors.updatedAt));
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
  const queued = and(eq(items.analysisStatus, "pending"), automaticAnalysisCondition(
    Math.max(1, Number(process.env.CONTENT_RETRY_MAX_ATTEMPTS) || 5), since,
  ))!;
  const unqueued = sql`${items.analysisStatus} not in ('success', 'partial', 'failed') and not (${queued})`;

  const [platforms, newItemsRows, runRows] = await Promise.all([
    db
      .select({
        platform: sourceItems.platform,
        total: sql<number>`count(distinct ${items.id})::int`,
        withSummary: sql<number>`count(distinct case when nullif(btrim(${items.aiSummary}), '') is not null then ${items.id} end)::int`,
        structured: sql<number>`count(distinct case when nullif(btrim(${items.contentType}), '') is not null and jsonb_array_length(${items.topicTags}) > 0 then ${items.id} end)::int`,
        analysisReady: sql<number>`count(distinct case when ${items.analysisStatus} in ('success', 'partial') then ${items.id} end)::int`,
        analysisFailed: sql<number>`count(distinct case when ${items.analysisStatus} = 'failed' then ${items.id} end)::int`,
        analysisPending: sql<number>`count(distinct case when ${queued} then ${items.id} end)::int`,
        analysisUnqueued: sql<number>`count(distinct case when ${unqueued} then ${items.id} end)::int`,
        projectionPending: sql<number>`count(distinct case when exists (
          select 1 from item_matches im where im.item_id = ${items.id} and im.retention_status = 'kept'
        ) and (${items.analysisStatus} <> 'pending' or ${items.analysisVersion} is null
          or ${items.contentRevision} > 1 or ${eventItems.itemId} is not null)
          and (${eventItems.itemId} is null or ${eventItems.sourceRevision} <> ${items.contentRevision}
          or ${eventItems.signalFingerprint} is distinct from case when ${items.eventSignal} is not null then md5(${items.eventSignal}::text) end)
          then ${items.id} end)::int`,
        explained: sql<number>`count(distinct case when nullif(btrim(coalesce(${items.editorialReason}, case when ${items.retentionSource} = 'model' then ${items.retentionReason} end)), '') is not null and ${items.informationValueScore} is not null then ${items.id} end)::int`,
        withFullText: sql<number>`count(distinct case when nullif(btrim(${items.contentHtml}), '') is not null then ${items.id} end)::int`,
        fallbackFullText: sql<number>`count(distinct case when nullif(btrim(${items.contentHtml}), '') is not null and ${items.contentProvider} in ('direct', 'wechat_download_api') then ${items.id} end)::int`,
        fullTextFailed: sql<number>`count(distinct case when ${items.contentFetchStatus} = 'failed' then ${items.id} end)::int`,
      })
      .from(sourceItems)
      .innerJoin(items, eq(sourceItems.itemId, items.id))
      .leftJoin(eventItems, eq(eventItems.itemId, items.id))
      .where(activeItem)
      .groupBy(sourceItems.platform),
    db
      .select({
        count: sql<number>`count(case when ${items.createdAt} >= ${since.toISOString()}::timestamptz then 1 end)::int`,
        pending: sql<number>`count(case when ${queued} then 1 end)::int`,
        unqueued: sql<number>`count(case when ${unqueued} then 1 end)::int`,
        oldestPendingAt: sql<Date | null>`min(case when ${queued} then ${items.contentObservedAt} end)`,
        processed24h: sql<number>`count(case when ${items.analysisStatus} in ('success', 'partial')
          and ${items.analyzedAt} >= ${since.toISOString()}::timestamptz then 1 end)::int`,
      })
      .from(items)
      .where(activeItem),
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
    queue: newItemsRows[0],
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

// ── Login rate limiting ────────────────────────────────────────────────

const LOGIN_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;

export async function checkLoginRateLimit(key: string): Promise<number | null> {
  const now = new Date();
  const [row] = await db
    .select({
      blockedUntil: loginAttempts.blockedUntil,
      attemptCount: loginAttempts.attemptCount,
      windowStartedAt: loginAttempts.windowStartedAt,
    })
    .from(loginAttempts)
    .where(eq(loginAttempts.attemptKey, key));
  if (!row) return null;
  if (row.blockedUntil && new Date(row.blockedUntil) > now) {
    return Math.ceil((new Date(row.blockedUntil).getTime() - now.getTime()) / 1000);
  }
  if (new Date(row.windowStartedAt).getTime() + LOGIN_ATTEMPT_WINDOW_MS <= now.getTime()) {
    return null;
  }
  return row.attemptCount >= LOGIN_MAX_ATTEMPTS
    ? Math.ceil((new Date(row.windowStartedAt).getTime() + LOGIN_ATTEMPT_WINDOW_MS - now.getTime()) / 1000)
    : null;
}

export async function recordLoginAttempt(key: string): Promise<void> {
  const now = new Date();
  await db
    .insert(loginAttempts)
    .values({ attemptKey: key, windowStartedAt: now, attemptCount: 1 })
    .onConflictDoUpdate({
      target: loginAttempts.attemptKey,
      set: {
        windowStartedAt: sql`CASE
          WHEN ${loginAttempts.windowStartedAt} + interval '10 minutes' <= ${now.toISOString()}
          THEN ${now.toISOString()}
          ELSE ${loginAttempts.windowStartedAt}
        END`,
        attemptCount: sql`CASE
          WHEN ${loginAttempts.windowStartedAt} + interval '10 minutes' <= ${now.toISOString()}
          THEN 1
          ELSE ${loginAttempts.attemptCount} + 1
        END`,
        blockedUntil: sql`CASE
          WHEN ${loginAttempts.windowStartedAt} + interval '10 minutes' <= ${now.toISOString()}
          THEN NULL
          ELSE ${loginAttempts.blockedUntil}
        END`,
        updatedAt: now,
      },
    });

  const [row] = await db
    .select({ attemptCount: loginAttempts.attemptCount, windowStartedAt: loginAttempts.windowStartedAt })
    .from(loginAttempts)
    .where(eq(loginAttempts.attemptKey, key));
  if (row && row.attemptCount >= LOGIN_MAX_ATTEMPTS) {
    await db
      .update(loginAttempts)
      .set({
        blockedUntil: new Date(new Date(row.windowStartedAt).getTime() + LOGIN_ATTEMPT_WINDOW_MS),
        updatedAt: now,
      })
      .where(eq(loginAttempts.attemptKey, key));
  }
}

export async function clearLoginAttempts(key: string): Promise<void> {
  await db.delete(loginAttempts).where(eq(loginAttempts.attemptKey, key));
}
