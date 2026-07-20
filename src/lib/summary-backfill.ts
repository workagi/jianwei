import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { items } from "@/db/schema";
import { loadApiCredentials } from "@/db/queries";
import type { NormalizedItem } from "@/connectors/types";
import { createRuntimeWeRssConnector } from "@/connectors/factory";
import { isWithinFullTextCooldown } from "@/connectors/wechat/full-text-resolver";
import { generateTitleTranslations, isSummaryEnabled, type SummaryRunStats } from "@/lib/summarizer";
import { routeContentItems } from "@/lib/content-router";
import { passesTrendRadarReaderGate } from "@/lib/trendradar-interest-filter";

const SUMMARY_CREDENTIAL_KEYS = [
  "SUMMARY_PROVIDER",
  "SUMMARY_BASE_URL",
  "SUMMARY_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
  "ARK_API_KEY",
  "VOLCENGINE_API_KEY",
  "SUMMARY_MODEL",
  "SUMMARY_SKIP_PLATFORMS",
  "SUMMARY_MAX_INPUT_CHARS",
  "SUMMARY_MAX_CONCURRENCY",
  "SUMMARY_REQUESTS_PER_MINUTE",
  "SUMMARY_REQUEST_INTERVAL_MS",
  "SUMMARY_TIMEOUT_SECONDS",
  "SUMMARY_INPUT_COST_PER_1M_USD",
  "SUMMARY_OUTPUT_COST_PER_1M_USD",
];

export interface SummaryBackfillResult {
  candidates: number;
  processed: number;
  updated: number;
  fullTextFetched?: number;
  stats: SummaryRunStats;
}

/**
 * failures: only analysis_status=failed (worker auto-retry)
 * missing_summary: only rows with empty ai_summary (worker auto, cost-safe)
 * incomplete: manual admin backfill — missing summary / type / tags / title translation
 *
 * Never re-runs solely because retention_source is rules or analysis_version is old.
 */
export type SummaryBackfillScope = "failures" | "missing_summary" | "incomplete";

export interface SummaryBackfillOptions {
  /** @deprecated prefer scope: "failures" */
  failuresOnly?: boolean;
  scope?: SummaryBackfillScope;
  retryAfterMinutes?: number;
  maxAttempts?: number;
}

export function resolveBackfillScope(options: SummaryBackfillOptions = {}): SummaryBackfillScope {
  if (options.scope) return options.scope;
  if (options.failuresOnly) return "failures";
  // Manual API / button default: fill true field gaps only, not "quality" re-runs.
  return "incomplete";
}

export interface TitleBackfillResult {
  candidates: number;
  updated: number;
}

function clampLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 10;
  return Math.min(Math.floor(parsed), 50);
}

function backfillScanLimit(limit: number): number {
  // Interest rules are editable regular expressions and therefore applied in
  // process rather than duplicated as an unsafe SQL approximation. Scan a
  // wider bounded window so excluded hotlist rows cannot occupy the requested
  // batch and starve eligible content behind them.
  return Math.min(5_000, Math.max(500, limit * 100));
}

/**
 * Model spend only for rows the reader would show.
 * TrendRadar uses the same gate as ingest + homepage; other platforms always pass.
 */
export function shouldProcessModelBackfill(
  row: Pick<BackfillRow, "platform" | "title" | "bodyText" | "authorName">,
  trendRadarGate: typeof passesTrendRadarReaderGate = passesTrendRadarReaderGate,
): boolean {
  if (row.platform !== "trendradar") return true;
  return trendRadarGate({
    title: row.title,
    text: row.bodyText,
    authorName: row.authorName,
  });
}

async function refreshSummaryCredentials(): Promise<void> {
  const rows = await loadApiCredentials();
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  for (const key of SUMMARY_CREDENTIAL_KEYS) {
    const value = byKey.get(key);
    if (value !== undefined) process.env[key] = value;
  }
}

export async function backfillMissingTranslatedTitles(rawLimit: unknown): Promise<TitleBackfillResult> {
  await refreshSummaryCredentials();
  if (!isSummaryEnabled()) return { candidates: 0, updated: 0 };
  const limit = Math.min(Math.max(Number(rawLimit) || 50, 1), 200);
  const candidateRows = await db
    .select({
      id: items.id,
      platform: items.platform,
      title: items.title,
      bodyText: items.bodyText,
      authorName: items.authorName,
    })
    .from(items)
    .where(sql`
      (${items.translatedTitle} is null or btrim(${items.translatedTitle}) = '')
      and ${items.title} ~ '[A-Za-z]'
      and ${items.title} !~ '[一-龥]'
      and exists (select 1 from item_matches where item_matches.item_id = ${items.id})
    `)
    .orderBy(desc(items.publishedAt))
    .limit(backfillScanLimit(limit));
  const rows = candidateRows.filter((row) => shouldProcessModelBackfill(row)).slice(0, limit);

  let updated = 0;
  for (let index = 0; index < rows.length; index += 10) {
    const batch = rows.slice(index, index + 10).flatMap((row) => row.title ? [{ id: row.id, title: row.title }] : []);
    const translated = await generateTitleTranslations(batch);
    for (const [id, translatedTitle] of translated) {
      await db.update(items).set({ translatedTitle, updatedAt: new Date() }).where(eq(items.id, id));
      updated += 1;
    }
  }
  return { candidates: rows.length, updated };
}

function defaultStats(status: SummaryRunStats["status"]): SummaryRunStats {
  return {
    status,
    attempted: 0,
    succeeded: 0,
    failed: 0,
  };
}

type BackfillRow = {
  id: string;
  platform: NormalizedItem["platform"];
  upstreamId: string;
  canonicalUrl: string;
  authorId: string | null;
  authorName: string | null;
  authorHandle: string | null;
  title: string | null;
  translatedTitle: string | null;
  bodyText: string;
  contentHtml: string | null;
  contentFetchStatus: string | null;
  contentFetchedAt: Date | null;
  imageUrls: string[];
  publishedAt: Date;
  analysisAttempts: number;
};

async function hydrateWechatFullText(rows: BackfillRow[]): Promise<number> {
  // Only articles that truly lack body HTML, not already-failed inside cooldown.
  // Serial (concurrency 1): WeRSS browser path is process-locked; parallel workers
  // only queue and still risk overlapping work across backfill entry points.
  const maxPerCycle = Math.max(1, Math.min(Number(process.env.WECHAT_FULLTEXT_BACKFILL_BATCH) || 3, 8));
  const targets = rows
    .filter(
      (row) =>
        row.platform === "wechat" &&
        !row.contentHtml?.trim() &&
        row.canonicalUrl &&
        !isWithinFullTextCooldown(row.contentFetchStatus, row.contentFetchedAt),
    )
    .slice(0, maxPerCycle);
  if (!targets.length) return 0;

  const connector = await createRuntimeWeRssConnector();
  let fetched = 0;
  for (const row of targets) {
    const result = await connector.fetchFullTextResult(row.canonicalUrl);
    if (result.html) {
      row.contentHtml = result.html;
      fetched += 1;
    }
    await db
      .update(items)
      .set({
        ...(result.html ? { contentHtml: result.html, contentProvider: result.provider } : {}),
        contentFetchStatus: result.status,
        contentFetchError: result.errorCode ?? null,
        contentFetchedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(items.id, row.id));
  }
  return fetched;
}

export async function backfillMissingSummaries(
  rawLimit: unknown,
  options: SummaryBackfillOptions = {},
): Promise<SummaryBackfillResult> {
  await refreshSummaryCredentials();
  const limit = clampLimit(rawLimit);

  if (!isSummaryEnabled()) {
    return {
      candidates: 0,
      processed: 0,
      updated: 0,
      stats: defaultStats("disabled"),
    };
  }

  const scope = resolveBackfillScope(options);
  // Manual incomplete may re-try stubborn rows; auto scopes stay strict.
  const maxAttempts = Math.max(
    1,
    options.maxAttempts ?? (scope === "incomplete" ? 20 : 5),
  );
  const retryCutoff = new Date(Date.now() - Math.max(1, options.retryAfterMinutes ?? 15) * 60_000);

  // Cost guardrails:
  // - never re-call the model just because keep_reason fell back to rules
  // - never re-call just because analysis_version changed
  // - auto worker only touches empty summaries or hard failures
  const missingSummarySql = sql`(${items.aiSummary} is null or btrim(${items.aiSummary}) = '')`;
  const missingClassificationSql = sql`(
    ${items.contentType} is null
    or jsonb_array_length(${items.topicTags}) = 0
  )`;
  const missingTitleTranslationSql = sql`(
    (
      (${items.translatedTitle} is null or btrim(${items.translatedTitle}) = '')
      and ${items.title} ~ '[A-Za-z]'
      and ${items.title} !~ '[一-龥]'
    )
    or (
      ${items.platform} = 'x'
      and (${items.translatedTitle} is null or btrim(${items.translatedTitle}) = '')
      and ${items.bodyText} ~ '[A-Za-z]'
      and ${items.bodyText} !~ '[一-龥]'
    )
  )`;

  const candidateFilter =
    scope === "failures"
      ? and(
          eq(items.analysisStatus, "failed"),
          lt(items.analysisAttempts, maxAttempts),
          or(isNull(items.analyzedAt), lt(items.analyzedAt, retryCutoff)),
        )
      : scope === "missing_summary"
        ? and(
            missingSummarySql,
            // Leave hard failures to the failures scope (cooldown + attempt budget).
            sql`${items.analysisStatus} is distinct from 'failed'`,
            lt(items.analysisAttempts, maxAttempts),
          )
        : // incomplete (manual): true field gaps only
          and(
            sql`(
              ${missingSummarySql}
              or ${missingClassificationSql}
              or ${missingTitleTranslationSql}
              or ${items.analysisStatus} = 'pending'
            )`,
            // Do not burn tokens re-polishing successful rows that already have a summary.
            sql`not (
              ${items.analysisStatus} in ('success', 'partial')
              and ${items.aiSummary} is not null
              and btrim(${items.aiSummary}) <> ''
              and ${items.contentType} is not null
              and jsonb_array_length(${items.topicTags}) > 0
              and not (${missingTitleTranslationSql})
            )`,
            lt(items.analysisAttempts, maxAttempts),
          );

  const candidateRows: BackfillRow[] = (await db
    .select({
      id: items.id,
      platform: items.platform,
      upstreamId: items.upstreamId,
      canonicalUrl: items.canonicalUrl,
      authorId: items.authorId,
      authorName: items.authorName,
      authorHandle: items.authorHandle,
      title: items.title,
      translatedTitle: items.translatedTitle,
      bodyText: items.bodyText,
      contentHtml: items.contentHtml,
      contentFetchStatus: items.contentFetchStatus,
      contentFetchedAt: items.contentFetchedAt,
      imageUrls: items.imageUrls,
      publishedAt: items.publishedAt,
      analysisAttempts: items.analysisAttempts,
    })
    .from(items)
    .where(candidateFilter)
    .orderBy(
      sql`case
        when ${items.platform} = 'wechat' and ${items.aiSummary} is null and ${items.contentHtml} is not null then 0
        when ${items.aiSummary} is null or btrim(${items.aiSummary}) = '' then 1
        when ${items.platform} = 'wechat' and ${items.aiSummary} is null then 2
        else 3
      end`,
      desc(items.publishedAt),
    )
    .limit(backfillScanLimit(limit))) as BackfillRow[];
  const rows = candidateRows.filter((row) => shouldProcessModelBackfill(row)).slice(0, limit);

  if (rows.length === 0) {
    return {
      candidates: 0,
      processed: 0,
      updated: 0,
      stats: defaultStats("not_applicable"),
    };
  }

  const fullTextFetched = await hydrateWechatFullText(rows);

  const normalized: NormalizedItem[] = rows.map((row) => ({
    platform: row.platform,
    upstreamId: row.upstreamId,
    canonicalUrl: row.canonicalUrl,
    authorId: row.authorId ?? undefined,
    authorName: row.authorName ?? undefined,
    authorHandle: row.authorHandle ?? undefined,
    title: row.title ?? undefined,
    text: row.bodyText,
    contentHtml: row.contentHtml ?? undefined,
    imageUrls: row.imageUrls ?? [],
    publishedAt: row.publishedAt,
    raw: { backfill: true, itemId: row.id },
  }));

  const { outcomes, stats } = await routeContentItems(normalized);
  let updated = 0;
  let processed = 0;
  for (const row of rows) {
    const outcome = outcomes.get(`${row.platform}|${row.upstreamId}`);
    if (!outcome) continue;
    await db
      .update(items)
      .set({
        ...(outcome.summary ? { aiSummary: outcome.summary } : {}),
        ...(outcome.translatedTitle ? { translatedTitle: outcome.translatedTitle } : {}),
        contentType: outcome.contentType,
        topicTags: outcome.topicTags,
        retentionReason: outcome.retentionReason || null,
        relevanceScore: outcome.relevanceScore,
        retentionSource: outcome.retentionSource,
        analysisStatus: outcome.status,
        analysisProvider: outcome.provider ?? null,
        analysisModel: outcome.model ?? null,
        analysisVersion: outcome.version,
        analysisAttempts: row.analysisAttempts + outcome.attempts,
        analysisErrorCode: outcome.errorCode ?? null,
        analysisErrorMessage: outcome.errorMessage ?? null,
        analyzedAt: outcome.processedAt,
        updatedAt: new Date(),
      })
      .where(eq(items.id, row.id));
    processed += 1;
    if (outcome.summary) updated += 1;
  }

  return {
    candidates: rows.length,
    processed,
    updated,
    fullTextFetched,
    stats,
  };
}
