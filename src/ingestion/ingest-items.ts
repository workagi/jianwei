import type { NormalizedItem } from "@/connectors/types";
import { canonicalizeUrl, contentFingerprint, dedupeKey } from "./deduplicate";
import { db } from "@/db";
import { items, itemMatches } from "@/db/schema";
import { and, eq, inArray, or } from "drizzle-orm";
import { type SummaryRunStats } from "@/lib/summarizer";
import { routeContentItems } from "@/lib/content-router";
import { deriveItemClassification } from "@/lib/item-tags";
import { deriveRetentionDecision } from "@/lib/content-retention";

/** Insert-ready row shape for the `items` table (driven by the Drizzle schema). */
export type IngestItemRow = typeof items.$inferInsert;

const FUTURE_SKEW_MS = 5 * 60 * 1000;

export function safePublishedAt(value: Date, now = new Date()): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return now;
  if (value.getTime() > now.getTime() + FUTURE_SKEW_MS) return now;
  return value;
}

function safeCanonicalUrl(raw: string | undefined, platform: string, upstreamId: string): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return `signaldeck:orphan:${platform}:${upstreamId}`;
  try {
    return canonicalizeUrl(trimmed);
  } catch {
    return trimmed;
  }
}

/**
 * Normalize connector output into insert rows.
 *
 * Deduplication follows the same three-level key used everywhere else:
 * upstream ID → canonical URL → content fingerprint. Duplicates within a single
 * batch collapse to the first occurrence so re-ingesting the same payload is a
 * no-op at the unique index.
 */
export function toItemRows(input: NormalizedItem[]): IngestItemRow[] {
  const seenKeys = new Set<string>();
  const seenUrls = new Set<string>();
  const out: IngestItemRow[] = [];
  const now = new Date();

  for (const item of input) {
    const key = dedupeKey(item);
    if (seenKeys.has(key)) continue;

    const canonical = safeCanonicalUrl(item.canonicalUrl, item.platform, item.upstreamId);
    // `items.canonical_url` is globally unique. Collapse same-URL rows even when
    // upstream ids differ (common when WeRSS id formats change).
    if (seenUrls.has(canonical)) continue;
    seenKeys.add(key);
    seenUrls.add(canonical);

    const classification = deriveItemClassification({
      platform: item.platform,
      authorName: item.authorName ?? null,
      authorHandle: item.authorHandle ?? null,
      title: item.title ?? null,
      bodyText: item.text,
      aiSummary: null,
    });
    const retention = deriveRetentionDecision({
      item,
      contentType: classification.contentType,
      topicTags: classification.topicTags,
    });
    out.push({
      platform: item.platform,
      sourceProvider: item.sourceProvider ?? null,
      upstreamId: item.upstreamId,
      canonicalUrl: canonical,
      authorId: item.authorId ?? null,
      authorName: item.authorName ?? null,
      authorHandle: item.authorHandle ?? null,
      avatarUrl: item.avatarUrl ?? null,
      title: item.title ?? null,
      bodyText: item.text,
      contentType: classification.contentType,
      topicTags: classification.topicTags,
      // A generic rule fallback must not be displayed as if it were a
      // model-authored recommendation reason.
      retentionReason: null,
      relevanceScore: retention.relevanceScore,
      retentionSource: retention.source,
      analysisStatus: "pending",
      // X quote payload reuses contentHtml as a JSON envelope (type=x_quote).
      // WeChat full-text HTML continues to use the same column with HTML markup.
      contentHtml: item.contentHtml ?? null,
      contentProvider: item.contentProvider ?? null,
      contentFetchStatus: item.contentFetchStatus ?? null,
      contentFetchError: item.contentFetchError ?? null,
      contentFetchedAt: item.contentFetchedAt ?? null,
      imageUrls: item.imageUrls ?? [],
      publishedAt: safePublishedAt(item.publishedAt, now),
      fetchedAt: now,
      updatedAt: now,
      contentHash: contentFingerprint(item),
    });
  }

  return out;
}

export interface IngestMatchLink {
  itemId: string;
  monitorId: string;
  matchedQuery?: string;
  rawPayload?: unknown;
}

/** Storage boundary so `ingest` stays pure and testable without a live DB. */
export interface IngestRepository {
  upsertItems(
    rows: IngestItemRow[],
  ): Promise<Array<{ id: string; platform: NormalizedItem["platform"]; upstreamId: string }>>;
  linkMatches(links: IngestMatchLink[]): Promise<number>;
  findExistingSourceKeys?(
    sources: Array<{ platform: NormalizedItem["platform"]; upstreamId: string }>,
  ): Promise<Set<string>>;
  /** Return canonical URLs that already exist so model routing can skip them. */
  findExistingCanonicalUrls?(canonicalUrls: string[]): Promise<Set<string>>;
}

export interface IngestResult {
  itemsUpserted: number;
  matchesInserted: number;
  summary: SummaryRunStats;
}

export interface IngestInput {
  items: NormalizedItem[];
  monitorId: string;
  matchedQuery?: string;
}

/**
 * Fully analysed ingest payload. Creating this value may call the model, but
 * does not mutate the database. It can therefore be prepared before opening a
 * short commit transaction.
 */
export interface PreparedIngest {
  input: IngestInput;
  rows: IngestItemRow[];
  summary: SummaryRunStats;
}

function defaultSummaryStats(status: SummaryRunStats["status"]): SummaryRunStats {
  return {
    status,
    attempted: 0,
    succeeded: 0,
    failed: 0,
  };
}

function sourceKey(platform: string, upstreamId: string): string {
  return `${platform}|${upstreamId}`;
}

async function findExistingSourceKeys(
  repo: IngestRepository,
  sources: Array<{ platform: NormalizedItem["platform"]; upstreamId: string }>,
): Promise<Set<string>> {
  if (repo.findExistingSourceKeys) return repo.findExistingSourceKeys(sources);
  return new Set();
}

async function findExistingCanonicalUrls(repo: IngestRepository, urls: string[]): Promise<Set<string>> {
  if (repo.findExistingCanonicalUrls) return repo.findExistingCanonicalUrls(urls);
  return new Set();
}

/** Analyse and normalize a batch without writing it. */
export async function prepareIngest(
  repo: IngestRepository,
  input: IngestInput,
): Promise<PreparedIngest> {
  const rows = toItemRows(input.items);
  if (rows.length === 0) {
    return { input, rows, summary: defaultSummaryStats("not_applicable") };
  }

  // Only unseen items enter the model route, preventing repeated API spend.
  // Every new item receives a durable route status, including disabled,
  // skipped and failed outcomes, so later retries can target exact rows.
  let summary = defaultSummaryStats("not_applicable");
  const sources = rows.map((r) => ({
    platform: r.platform as NormalizedItem["platform"],
    upstreamId: r.upstreamId as string,
  }));
  const canonicalUrls = rows.map((r) => r.canonicalUrl).filter(Boolean) as string[];
  if (sources.length) {
    const [existingUpstream, existingUrls] = await Promise.all([
      findExistingSourceKeys(repo, sources),
      findExistingCanonicalUrls(repo, canonicalUrls),
    ]);
    const newItems = input.items.filter((it) => {
      if (existingUpstream.has(sourceKey(it.platform, it.upstreamId))) return false;
      try {
        const url = safeCanonicalUrl(it.canonicalUrl, it.platform, it.upstreamId);
        if (existingUrls.has(url)) return false;
      } catch {
        // ignore
      }
      return true;
    });
    if (newItems.length) {
      const routed = await routeContentItems(newItems);
      summary = routed.stats;
      for (const row of rows) {
        const outcome = routed.outcomes.get(`${row.platform}|${row.upstreamId}`);
        if (!outcome) continue;
        if (outcome.summary) row.aiSummary = outcome.summary;
        if (outcome.translatedTitle) row.translatedTitle = outcome.translatedTitle;
        row.contentType = outcome.contentType;
        row.topicTags = outcome.topicTags;
        row.retentionReason = outcome.retentionReason || null;
        row.relevanceScore = outcome.relevanceScore;
        row.retentionSource = outcome.retentionSource;
        row.analysisStatus = outcome.status;
        row.analysisProvider = outcome.provider ?? null;
        row.analysisModel = outcome.model ?? null;
        row.analysisVersion = outcome.version;
        row.analysisAttempts = outcome.attempts;
        row.analysisErrorCode = outcome.errorCode ?? null;
        row.analysisErrorMessage = outcome.errorMessage ?? null;
        row.analyzedAt = outcome.processedAt;
      }
    }
  }

  return { input, rows, summary };
}

/**
 * Persist a prepared batch. This function performs no provider or model calls,
 * so callers may safely run it inside a short database transaction together
 * with cursor, usage-ledger and collection-run updates.
 */
export async function commitPreparedIngest(
  repo: IngestRepository,
  prepared: PreparedIngest,
): Promise<IngestResult> {
  const { input, rows, summary } = prepared;
  if (rows.length === 0) {
    return { itemsUpserted: 0, matchesInserted: 0, summary };
  }

  const upserted = await repo.upsertItems(rows);

  // Map returned identities back to source payloads. URL-merged rows keep a
  // historical upstream id, so also match by canonical URL.
  const rowByUpstream = new Map(rows.map((r) => [`${r.platform}|${r.upstreamId}`, r]));
  const rowByUrl = new Map(rows.map((r) => [r.canonicalUrl, r]));
  const sourceByUpstream = new Map(
    input.items.map((it) => [`${it.platform}|${it.upstreamId}`, it] as const),
  );
  const sourceByUrl = new Map(
    input.items.map((it) => {
      try {
        return [safeCanonicalUrl(it.canonicalUrl, it.platform, it.upstreamId), it] as const;
      } catch {
        return [it.canonicalUrl, it] as const;
      }
    }),
  );

  const links: IngestMatchLink[] = upserted.map((u) => {
    const row =
      rowByUpstream.get(`${u.platform}|${u.upstreamId}`) ??
      [...rowByUrl.values()].find((r) => r.platform === u.platform && r.upstreamId === u.upstreamId);
    const source =
      sourceByUpstream.get(`${u.platform}|${u.upstreamId}`) ??
      (row ? sourceByUrl.get(row.canonicalUrl) : undefined);
    return {
      itemId: u.id,
      monitorId: input.monitorId,
      matchedQuery: input.matchedQuery,
      rawPayload: source?.raw ?? {},
    };
  });

  const matchesInserted = await repo.linkMatches(links);
  return { itemsUpserted: upserted.length, matchesInserted, summary };
}

/**
 * Convenience wrapper used outside the worker transaction path.
 * Idempotent: same upstream ID re-upserts the row; the match link is ignored on
 * conflict so a monitor re-collecting old items does not create duplicate edges.
 */
export async function ingest(
  repo: IngestRepository,
  input: IngestInput,
): Promise<IngestResult> {
  const prepared = await prepareIngest(repo, input);
  return commitPreparedIngest(repo, prepared);
}

type UpsertedItem = {
  id: string;
  platform: NormalizedItem["platform"];
  upstreamId: string;
};

/**
 * Drizzle-backed implementation of {@link IngestRepository}.
 * Items upsert on (platform, upstream_id). When the same canonical_url already
 * exists under a different upstream id (WeRSS id format churn), update that
 * row instead of inserting — `items_canonical_url_uidx` is global.
 */
type IngestDatabase = Pick<typeof db, "select" | "insert" | "update">;

export function createDrizzleIngestRepository(database: IngestDatabase = db): IngestRepository {
  return {
    async upsertItems(rows) {
      if (rows.length === 0) return [];

      const urls = [...new Set(rows.map((r) => r.canonicalUrl).filter(Boolean))];
      type ExistingRow = UpsertedItem & {
        publishedAt: Date;
        contentType: string | null;
        topicTags: string[] | null;
      };
      const existingByUrl = new Map<string, ExistingRow>();
      if (urls.length) {
        const existing = await database
          .select({
            id: items.id,
            platform: items.platform,
            upstreamId: items.upstreamId,
            canonicalUrl: items.canonicalUrl,
            publishedAt: items.publishedAt,
            contentType: items.contentType,
            topicTags: items.topicTags,
          })
          .from(items)
          .where(inArray(items.canonicalUrl, urls));
        for (const row of existing) {
          existingByUrl.set(row.canonicalUrl, {
            id: row.id,
            platform: row.platform as NormalizedItem["platform"],
            upstreamId: row.upstreamId,
            publishedAt: row.publishedAt,
            contentType: row.contentType,
            topicTags: row.topicTags,
          });
        }
      }

      const toInsert: IngestItemRow[] = [];
      const merged: UpsertedItem[] = [];

      const mergeIntoExisting = async (row: IngestItemRow, hit: ExistingRow) => {
        // Same article, possibly different upstream id: refresh plain content
        // fields only. Keep historical identity (id / upstream_id) for matches.
        const patch: Partial<IngestItemRow> & { updatedAt: Date } = {
          authorId: row.authorId ?? null,
          authorName: row.authorName ?? null,
          authorHandle: row.authorHandle ?? null,
          title: row.title ?? null,
          bodyText: row.bodyText,
          imageUrls: row.imageUrls ?? [],
          contentHash: row.contentHash,
          updatedAt: new Date(),
        };
        if (row.avatarUrl) patch.avatarUrl = row.avatarUrl;
        if (row.sourceProvider) patch.sourceProvider = row.sourceProvider;
        if (row.contentHtml) {
          patch.contentHtml = row.contentHtml;
          patch.contentProvider = row.contentProvider ?? null;
          patch.contentFetchStatus = row.contentFetchStatus ?? null;
          patch.contentFetchError = null;
          if (row.contentFetchedAt) patch.contentFetchedAt = row.contentFetchedAt;
        }
        // Never move an existing item forward in the reader timeline.
        if (row.publishedAt < hit.publishedAt) patch.publishedAt = row.publishedAt;
        if (!hit.contentType && row.contentType) patch.contentType = row.contentType;
        if ((!hit.topicTags || hit.topicTags.length === 0) && row.topicTags?.length) {
          patch.topicTags = row.topicTags;
        }
        if (row.retentionReason) patch.retentionReason = row.retentionReason;
        if (row.relevanceScore != null) patch.relevanceScore = row.relevanceScore;
        if (row.retentionSource) patch.retentionSource = row.retentionSource;

        await database.update(items).set(patch).where(eq(items.id, hit.id));
        merged.push({ id: hit.id, platform: hit.platform, upstreamId: hit.upstreamId });
      };

      for (const row of rows) {
        const hit = existingByUrl.get(row.canonicalUrl);
        if (!hit) {
          toInsert.push(row);
          continue;
        }
        await mergeIntoExisting(row, hit);
      }

      if (toInsert.length === 0) return merged;

      const inserted: UpsertedItem[] = [];
      // Insert one row at a time and ignore every unique conflict. This is
      // transaction-safe: catching a PostgreSQL 23505 would leave the entire
      // transaction aborted. A no-op conflict lets us reselect and merge into
      // whichever source/canonical row won the race.
      for (const row of toInsert) {
        const [saved] = await database
          .insert(items)
          .values(row as typeof items.$inferInsert)
          .onConflictDoNothing()
          .returning({
            id: items.id,
            platform: items.platform,
            upstreamId: items.upstreamId,
          });
        if (saved) {
          inserted.push({
            id: saved.id,
            platform: saved.platform as NormalizedItem["platform"],
            upstreamId: saved.upstreamId,
          });
          continue;
        }

        const [winner] = await database
          .select({
            id: items.id,
            platform: items.platform,
            upstreamId: items.upstreamId,
            publishedAt: items.publishedAt,
            contentType: items.contentType,
            topicTags: items.topicTags,
          })
          .from(items)
          .where(or(
            and(eq(items.platform, row.platform), eq(items.upstreamId, row.upstreamId)),
            eq(items.canonicalUrl, row.canonicalUrl),
          ))
          .limit(1);
        if (!winner) throw new Error("INGEST_CONFLICT_WINNER_NOT_FOUND");
        await mergeIntoExisting(row, {
          ...winner,
          platform: winner.platform as NormalizedItem["platform"],
        });
      }

      return [
        ...merged,
        ...inserted,
      ];
    },

    async findExistingSourceKeys(sources) {
      if (sources.length === 0) return new Set();
      const existing = await database
        .select({ platform: items.platform, upstreamId: items.upstreamId })
        .from(items)
        .where(or(...sources.map((source) => and(
          eq(items.platform, source.platform),
          eq(items.upstreamId, source.upstreamId),
        ))));
      return new Set(existing.map((e) => sourceKey(e.platform, e.upstreamId)));
    },

    async findExistingCanonicalUrls(canonicalUrls) {
      if (canonicalUrls.length === 0) return new Set();
      const existing = await database
        .select({ canonicalUrl: items.canonicalUrl })
        .from(items)
        .where(inArray(items.canonicalUrl, canonicalUrls));
      return new Set(existing.map((e) => e.canonicalUrl));
    },

    async linkMatches(links) {
      if (links.length === 0) return 0;
      const inserted = await database
        .insert(itemMatches)
        .values(
          links.map((link) => ({
            itemId: link.itemId,
            monitorId: link.monitorId,
            matchedQuery: link.matchedQuery ?? null,
            rawPayload: (link.rawPayload ?? {}) as Record<string, unknown>,
          })),
        )
        .onConflictDoNothing()
        .returning({ itemId: itemMatches.itemId });
      return inserted.length;
    },
  };
}
