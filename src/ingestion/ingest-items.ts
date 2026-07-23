import type { NormalizedItem } from "@/connectors/types";
import { canonicalizeUrl, contentFingerprint, dedupeKey } from "./deduplicate";
import { db } from "@/db";
import { items, itemMatches, monitorMatchObservations, sourceItems } from "@/db/schema";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { type SummaryRunStats } from "@/lib/summarizer";
import { routeContentItems } from "@/lib/content-router";
import { deriveItemClassification } from "@/lib/item-tags";
import { deriveRetentionDecision, type MonitorRules, deriveMonitorRetention } from "@/lib/content-retention";
import { createStructuredLogger } from "@/lib/structured-log";

const ingestionLog = createStructuredLogger({ service: "ingestion" });

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
     informationValueScore: retention.relevanceScore,
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
  sourceItemId?: string;
  matchedQuery?: string;
  relevanceScore?: number;
  retentionReason?: string;
  retentionSource?: string;
  analysisStatus?: string;
  analysisVersion?: string;
  rawPayload?: unknown;
  collectionRunId?: string;
}

export interface IngestSourceObservation {
  itemId: string;
  platform: NormalizedItem["platform"];
  sourceProvider: string;
  upstreamId: string;
  sourceUrl: string;
  authorId?: string;
  authorName?: string;
  authorHandle?: string;
  avatarUrl?: string;
  rawPayload: Record<string, unknown>;
  publishedAt: Date;
}

export interface StoredSourceObservation {
  id: string;
  itemId: string;
  platform: NormalizedItem["platform"];
  sourceProvider: string;
  upstreamId: string;
}

export interface UpsertedDocument {
  id: string;
  platform: NormalizedItem["platform"];
  upstreamId: string;
  canonicalUrl: string;
}

/** Storage boundary so `ingest` stays pure and testable without a live DB. */
export interface IngestRepository {
  upsertItems(
    rows: IngestItemRow[],
  ): Promise<UpsertedDocument[]>;
  upsertSourceItems(observations: IngestSourceObservation[]): Promise<StoredSourceObservation[]>;
  linkMatches(links: IngestMatchLink[]): Promise<number>;
  findExistingSourceKeys?(
    sources: Array<{ platform: NormalizedItem["platform"]; sourceProvider: string; upstreamId: string }>,
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
  runId?: string;
  monitorRules?: MonitorRules;
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

function sourceProvider(item: NormalizedItem): string {
  return item.sourceProvider?.trim() || item.platform;
}

function sourceIdentity(platform: string, provider: string, upstreamId: string): string {
  return `${platform}|${provider}|${upstreamId}`;
}

function rawPayloadRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return value == null ? {} : { value };
}

async function findExistingSourceKeys(
  repo: IngestRepository,
  sources: Array<{ platform: NormalizedItem["platform"]; sourceProvider: string; upstreamId: string }>,
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
    sourceProvider: r.sourceProvider?.trim() || String(r.platform),
    upstreamId: r.upstreamId as string,
  }));
  const canonicalUrls = rows.map((r) => r.canonicalUrl).filter(Boolean) as string[];
  if (sources.length) {
    const [existingUpstream, existingUrls] = await Promise.all([
      findExistingSourceKeys(repo, sources),
      findExistingCanonicalUrls(repo, canonicalUrls),
    ]);
    const newItems = input.items.filter((it) => {
      if (existingUpstream.has(sourceIdentity(it.platform, sourceProvider(it), it.upstreamId))) return false;
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
       row.informationValueScore = outcome.relevanceScore;
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

  // Map every provider observation to the canonical document. URL-merged rows
  // keep a historical identity on `items`, while `source_items` preserves all
  // incoming provider/upstream identities independently.
  const rowByUpstream = new Map(rows.map((r) => [`${r.platform}|${r.upstreamId}`, r]));
  const rowByUrl = new Map(rows.map((r) => [r.canonicalUrl, r]));
  const documentByUrl = new Map(upserted.map((document) => [document.canonicalUrl, document]));
  const documentByLegacySource = new Map(
    upserted.map((document) => [sourceKey(document.platform, document.upstreamId), document]),
  );
  const observationByIdentity = new Map<string, IngestSourceObservation>();
  for (const source of input.items) {
    const canonicalUrl = safeCanonicalUrl(source.canonicalUrl, source.platform, source.upstreamId);
    const document = documentByUrl.get(canonicalUrl)
      ?? documentByLegacySource.get(sourceKey(source.platform, source.upstreamId));
    if (!document) continue;
    const provider = sourceProvider(source);
    observationByIdentity.set(sourceIdentity(source.platform, provider, source.upstreamId), {
      itemId: document.id,
      platform: source.platform,
      sourceProvider: provider,
      upstreamId: source.upstreamId,
      sourceUrl: canonicalUrl,
      authorId: source.authorId,
      authorName: source.authorName,
      authorHandle: source.authorHandle,
      avatarUrl: source.avatarUrl,
      rawPayload: rawPayloadRecord(source.raw),
      publishedAt: safePublishedAt(source.publishedAt),
    });
  }
  const observations = [...observationByIdentity.values()];
  const storedSources = await repo.upsertSourceItems(observations);
  const storedSourceByIdentity = new Map(storedSources.map((source) => [
    sourceIdentity(source.platform, source.sourceProvider, source.upstreamId),
    source,
  ]));

  // One document can have many source observations, but one monitor/document
  // edge remains unique. Keep the source that this run actually used and put
  // document analysis fields on the edge for monitor-specific evolution.
  const linksByItem = new Map<string, IngestMatchLink>();
  for (const observation of observations) {
    const storedSource = storedSourceByIdentity.get(sourceIdentity(
      observation.platform,
      observation.sourceProvider,
      observation.upstreamId,
    ));
    const itemId = storedSource?.itemId ?? observation.itemId;
    if (linksByItem.has(itemId)) continue;
    const row = rowByUrl.get(observation.sourceUrl)
      ?? rowByUpstream.get(sourceKey(observation.platform, observation.upstreamId));

    // Derive per-monitor relevance and retention from document analysis +
    // monitor rules. This is the MonitorMatchAnalysis layer: each monitor
    // evaluates the same document differently based on its keywords, content
    // type filters and topic preferences.
    const monitorRetention = input.monitorRules
      ? deriveMonitorRetention(input.monitorRules, {
          contentType: row?.contentType ?? "opinion",
          topicTags: row?.topicTags ?? [],
          summary: row?.aiSummary ?? undefined,
          informationValueScore: row?.informationValueScore ?? undefined,
          title: row?.title ?? undefined,
          bodyText: row?.bodyText ?? undefined,
        })
      : { relevanceScore: row?.informationValueScore ?? undefined, retentionReason: undefined as string | undefined };

   linksByItem.set(itemId, {
     itemId,
     monitorId: input.monitorId,
     sourceItemId: storedSource?.id,
     matchedQuery: input.matchedQuery,
      relevanceScore: monitorRetention.relevanceScore,
      retentionReason: monitorRetention.retentionReason ?? undefined,
      retentionSource: monitorRetention.retentionReason ? ("rules" as const) : undefined,
     analysisStatus: row?.analysisStatus ?? undefined,
      analysisVersion: row?.analysisVersion ?? undefined,
     rawPayload: observation.rawPayload,
      collectionRunId: input.runId,
    });
  }

  const matchesInserted = await repo.linkMatches([...linksByItem.values()]);
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
      type ExistingRow = UpsertedDocument & {
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
            canonicalUrl: row.canonicalUrl,
            publishedAt: row.publishedAt,
            contentType: row.contentType,
            topicTags: row.topicTags,
          });
        }
      }

      const toInsert: IngestItemRow[] = [];
      const merged: UpsertedDocument[] = [];

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
        if (row.informationValueScore != null) patch.informationValueScore = row.informationValueScore;
        if (row.relevanceScore != null) patch.relevanceScore = row.relevanceScore;
        if (row.retentionSource) patch.retentionSource = row.retentionSource;

        await database.update(items).set(patch).where(eq(items.id, hit.id));
        merged.push({
          id: hit.id,
          platform: hit.platform,
          upstreamId: hit.upstreamId,
          canonicalUrl: hit.canonicalUrl,
        });
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

      const inserted: UpsertedDocument[] = [];
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
            canonicalUrl: items.canonicalUrl,
          });
        if (saved) {
          inserted.push({
            id: saved.id,
            platform: saved.platform as NormalizedItem["platform"],
            upstreamId: saved.upstreamId,
            canonicalUrl: saved.canonicalUrl,
          });
          continue;
        }

        const [winner] = await database
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

    async upsertSourceItems(observations) {
      if (observations.length === 0) return [];
      const now = new Date();
      const returned = await database
        .insert(sourceItems)
        .values(
          observations.map((obs) => ({
            itemId: obs.itemId,
            platform: obs.platform,
            sourceProvider: obs.sourceProvider,
            upstreamId: obs.upstreamId,
            sourceUrl: obs.sourceUrl,
            authorId: obs.authorId ?? null,
            authorName: obs.authorName ?? null,
            authorHandle: obs.authorHandle ?? null,
            avatarUrl: obs.avatarUrl ?? null,
            rawPayload: obs.rawPayload,
            publishedAt: obs.publishedAt,
            lastSeenAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [sourceItems.platform, sourceItems.sourceProvider, sourceItems.upstreamId],
          set: {
            // Never silently re-bind a source identity to a different document.
            // Once bound, the source→document relationship is immutable in the
            // hot path. Re-canonicalization must go through an explicit merge
            // process that also migrates item_matches and observations.
            itemId: sql`coalesce(${sourceItems.itemId}, excluded.${sourceItems.itemId})`,
            sourceUrl: sql`excluded.${sourceItems.sourceUrl}`,
            authorId: sql`coalesce(excluded.${sourceItems.authorId}, ${sourceItems.authorId})`,
            authorName: sql`coalesce(excluded.${sourceItems.authorName}, ${sourceItems.authorName})`,
            authorHandle: sql`coalesce(excluded.${sourceItems.authorHandle}, ${sourceItems.authorHandle})`,
            avatarUrl: sql`coalesce(excluded.${sourceItems.avatarUrl}, ${sourceItems.avatarUrl})`,
            rawPayload: sql`excluded.${sourceItems.rawPayload}`,
            publishedAt: sql`excluded.${sourceItems.publishedAt}`,
            lastSeenAt: now,
          },
        })
        .returning({
          id: sourceItems.id,
          itemId: sourceItems.itemId,
          platform: sourceItems.platform,
          sourceProvider: sourceItems.sourceProvider,
          upstreamId: sourceItems.upstreamId,
        });
      for (const { itemId, platform, sourceProvider, upstreamId } of returned) {
        // When onConflict updated itemId, the returned row may come from
        // the new values. Detect re-assignments by comparing with the input.
        const input = observations.find(
          (obs) => obs.platform === platform && obs.sourceProvider === sourceProvider && obs.upstreamId === upstreamId,
        );
        if (input && input.itemId !== itemId) {
          ingestionLog.warn("source_items.item_reassigned", {
            platform,
            sourceProvider,
            upstreamId,
            previousDocumentId: itemId,
            currentDocumentId: input.itemId,
          });
        }
      }
      return returned.map((row) => ({ ...row, platform: row.platform as NormalizedItem["platform"] }));
    },

    async findExistingSourceKeys(sources) {
      if (sources.length === 0) return new Set();
      const existingSources = await database
        .select({
          platform: sourceItems.platform,
          sourceProvider: sourceItems.sourceProvider,
          upstreamId: sourceItems.upstreamId,
        })
        .from(sourceItems)
        .where(or(...sources.map((source) => and(
          eq(sourceItems.platform, source.platform),
          eq(sourceItems.sourceProvider, source.sourceProvider),
          eq(sourceItems.upstreamId, source.upstreamId),
        ))));
      const legacyItems = await database
        .select({
          platform: items.platform,
          sourceProvider: items.sourceProvider,
          upstreamId: items.upstreamId,
        })
        .from(items)
        .where(or(...sources.map((source) => and(
          eq(items.platform, source.platform),
          eq(items.upstreamId, source.upstreamId),
        ))));
      return new Set([
        ...existingSources.map((source) => sourceIdentity(
          source.platform,
          source.sourceProvider,
          source.upstreamId,
        )),
        ...legacyItems.map((item) => sourceIdentity(
          item.platform,
          item.sourceProvider?.trim() || item.platform,
          item.upstreamId,
        )),
      ]);
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
      const now = new Date();
      const result = await database
        .insert(itemMatches)
        .values(
          links.map((link) => ({
            itemId: link.itemId,
            monitorId: link.monitorId,
            sourceItemId: link.sourceItemId ?? null,
            matchedQuery: link.matchedQuery ?? null,
            relevanceScore: link.relevanceScore ?? null,
            retentionReason: link.retentionReason ?? null,
            retentionSource: link.retentionSource ?? null,
            analysisStatus: link.analysisStatus ?? null,
            analysisVersion: link.analysisVersion ?? null,
            rawPayload: (link.rawPayload ?? {}) as Record<string, unknown>,
            lastSeenAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [itemMatches.itemId, itemMatches.monitorId],
          set: {
            sourceItemId: sql`coalesce(excluded.${itemMatches.sourceItemId}, ${itemMatches.sourceItemId})`,
            matchedQuery: sql`coalesce(excluded.${itemMatches.matchedQuery}, ${itemMatches.matchedQuery})`,
            relevanceScore: sql`coalesce(excluded.${itemMatches.relevanceScore}, ${itemMatches.relevanceScore})`,
            retentionReason: sql`coalesce(excluded.${itemMatches.retentionReason}, ${itemMatches.retentionReason})`,
            retentionSource: sql`coalesce(excluded.${itemMatches.retentionSource}, ${itemMatches.retentionSource})`,
            analysisStatus: sql`coalesce(excluded.${itemMatches.analysisStatus}, ${itemMatches.analysisStatus})`,
            analysisVersion: sql`coalesce(excluded.${itemMatches.analysisVersion}, ${itemMatches.analysisVersion})`,
            rawPayload: sql`excluded.${itemMatches.rawPayload}`,
            lastSeenAt: now,
          },
        })
        .returning({ itemId: itemMatches.itemId });

      // Persist discovery evidence independently of the match aggregation.
      await database.insert(monitorMatchObservations).values(
        links.map((link) => ({
          matchItemId: link.itemId,
          matchMonitorId: link.monitorId,
          sourceItemId: link.sourceItemId ?? null,
          collectionRunId: link.collectionRunId ?? null,
          matchedQuery: link.matchedQuery ?? null,
          rawPayload: (link.rawPayload ?? {}) as Record<string, unknown>,
        })),
      ).onConflictDoNothing({
        target: [
          monitorMatchObservations.matchItemId,
          monitorMatchObservations.matchMonitorId,
          monitorMatchObservations.sourceItemId,
          monitorMatchObservations.collectionRunId,
        ],
      });

      return result.length;
    },
  };
}
