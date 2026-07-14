import type { NormalizedItem } from "@/connectors/types";
import { canonicalizeUrl, contentFingerprint, dedupeKey } from "./deduplicate";
import { db } from "@/db";
import { items, itemMatches } from "@/db/schema";
import { sql, inArray } from "drizzle-orm";
import { generateSummariesWithStats, isSummaryEnabled, type SummaryRunStats } from "@/lib/summarizer";
import { deriveItemClassification, normalizeContentType, normalizeTopicTags } from "@/lib/item-tags";

/** Insert-ready row shape for the `items` table (driven by the Drizzle schema). */
export type IngestItemRow = typeof items.$inferInsert;

const FUTURE_SKEW_MS = 5 * 60 * 1000;

export function safePublishedAt(value: Date, now = new Date()): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return now;
  if (value.getTime() > now.getTime() + FUTURE_SKEW_MS) return now;
  return value;
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
  const seen = new Set<string>();
  const out: IngestItemRow[] = [];
  const now = new Date();

  for (const item of input) {
    const key = dedupeKey(item);
    if (seen.has(key)) continue;
    seen.add(key);

    const canonical = item.canonicalUrl ? canonicalizeUrl(item.canonicalUrl) : "";
    const classification = deriveItemClassification({
      platform: item.platform,
      authorName: item.authorName ?? null,
      authorHandle: item.authorHandle ?? null,
      title: item.title ?? null,
      bodyText: item.text,
      aiSummary: null,
    });
    out.push({
      platform: item.platform,
      upstreamId: item.upstreamId,
      canonicalUrl: canonical,
      authorId: item.authorId ?? null,
      authorName: item.authorName ?? null,
      authorHandle: item.authorHandle ?? null,
      title: item.title ?? null,
      bodyText: item.text,
      contentType: classification.contentType,
      topicTags: classification.topicTags,
      contentHtml: item.contentHtml ?? null,
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
  findExistingUpstreamIds?(upstreamIds: string[]): Promise<Set<string>>;
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

function defaultSummaryStats(status: SummaryRunStats["status"]): SummaryRunStats {
  return {
    status,
    attempted: 0,
    succeeded: 0,
    failed: 0,
  };
}

async function findExistingUpstreamIds(repo: IngestRepository, upstreamIds: string[]): Promise<Set<string>> {
  if (repo.findExistingUpstreamIds) return repo.findExistingUpstreamIds(upstreamIds);
  const existing = await db
    .select({ upstreamId: items.upstreamId })
    .from(items)
    .where(inArray(items.upstreamId, upstreamIds));
  return new Set(existing.map((e) => e.upstreamId));
}

/**
 * Import a batch of normalized items for one monitor into the shared store.
 * Idempotent: same upstream ID re-upserts the row; the match link is ignored on
 * conflict so a monitor re-collecting old items does not create duplicate edges.
 */
export async function ingest(
  repo: IngestRepository,
  input: IngestInput,
): Promise<IngestResult> {
  const rows = toItemRows(input.items);
  if (rows.length === 0) {
    return { itemsUpserted: 0, matchesInserted: 0, summary: defaultSummaryStats("not_applicable") };
  }

  // 新条目（DB 中尚不存在的 upstreamId）才调用模型 API：避免每轮重复烧 LLM，
  // 且 upsertItems 的 onConflict 不更新 ai_summary，已有摘要/分类/标签不会被覆盖。
  let summary = defaultSummaryStats(isSummaryEnabled() ? "not_applicable" : "disabled");
  if (isSummaryEnabled()) {
    const upstreamIds = rows.map((r) => r.upstreamId).filter(Boolean) as string[];
    if (upstreamIds.length) {
      const existingSet = await findExistingUpstreamIds(repo, upstreamIds);
      const newItems = input.items.filter((it) => !existingSet.has(it.upstreamId));
      if (newItems.length) {
        const { analyses: analysisMap, stats } = await generateSummariesWithStats(newItems);
        summary = stats;
        if (analysisMap.size) {
          for (const row of rows) {
            const analysis = analysisMap.get(`${row.platform}|${row.upstreamId}`);
            if (analysis?.summary) row.aiSummary = analysis.summary;
            const contentType = normalizeContentType(analysis?.contentType);
            if (contentType) row.contentType = contentType;
            const topicTags = normalizeTopicTags(analysis?.topicTags);
            if (topicTags.length) row.topicTags = topicTags;
          }
        }
      }
    }
  }

  const upserted = await repo.upsertItems(rows);

  const links: IngestMatchLink[] = upserted.map((u) => {
    const source = input.items.find(
      (it) => it.platform === u.platform && it.upstreamId === u.upstreamId,
    );
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
 * Drizzle-backed implementation of {@link IngestRepository}.
 * Items upsert on (platform, upstream_id); matches link on (item_id, monitor_id).
 */
export function createDrizzleIngestRepository(database = db): IngestRepository {
  return {
    async upsertItems(rows) {
      if (rows.length === 0) return [];
      return database
        .insert(items)
        .values(rows as (typeof items.$inferInsert)[])
        .onConflictDoUpdate({
          target: [items.platform, items.upstreamId],
          set: {
            canonicalUrl: sql`excluded.canonical_url`,
            authorId: sql`excluded.author_id`,
            authorName: sql`excluded.author_name`,
            authorHandle: sql`excluded.author_handle`,
            title: sql`excluded.title`,
            bodyText: sql`excluded.body_text`,
            contentType: sql`excluded.content_type`,
            topicTags: sql`excluded.topic_tags`,
            contentHtml: sql`excluded.content_html`,
            imageUrls: sql`excluded.image_urls`,
            publishedAt: sql`excluded.published_at`,
            contentHash: sql`excluded.content_hash`,
            updatedAt: new Date(),
          },
        })
        .returning({
          id: items.id,
          platform: items.platform,
          upstreamId: items.upstreamId,
        });
    },

    async findExistingUpstreamIds(upstreamIds) {
      if (upstreamIds.length === 0) return new Set();
      const existing = await database
        .select({ upstreamId: items.upstreamId })
        .from(items)
        .where(inArray(items.upstreamId, upstreamIds));
      return new Set(existing.map((e) => e.upstreamId));
    },

    async linkMatches(links) {
      if (links.length === 0) return 0;
      await database
        .insert(itemMatches)
        .values(
          links.map((link) => ({
            itemId: link.itemId,
            monitorId: link.monitorId,
            matchedQuery: link.matchedQuery ?? null,
            rawPayload: (link.rawPayload ?? {}) as Record<string, unknown>,
          })),
        )
        .onConflictDoNothing();
      return links.length;
    },
  };
}
