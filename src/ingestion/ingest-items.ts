import type { NormalizedItem } from "@/connectors/types";
import { db } from "@/db";
import { canonicalizeUrl, contentFingerprint, dedupeKey } from "./deduplicate";
import { type SummaryRunStats } from "@/lib/summarizer";
import { routeContentItems, CONTENT_ANALYSIS_VERSION } from "@/lib/content-router";
import { deriveItemClassification } from "@/lib/item-tags";
import { deriveRetentionDecision, type MonitorRules, deriveMonitorRetention } from "@/lib/content-retention";
import {
  sourceKey,
  sourceProvider,
  sourceIdentity,
  canonicalUrlHash,
  WORKER_ID_FOR_CLAIM,
  type IngestItemRow,
  type IngestMatchLink,
  type IngestSourceObservation,
  type IngestRepository,
} from "./repositories";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export { createDrizzleIngestRepository } from "./repositories";

export type { IngestItemRow, IngestMatchLink, IngestSourceObservation, StoredSourceObservation, UpsertedDocument, IngestRepository } from "./repositories";

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
async function claimDocumentAnalyses(
  repo: IngestRepository,
  newItems: NormalizedItem[],
): Promise<NormalizedItem[]> {
  if (!repo.claimDocumentAnalysis) return newItems;
  const claimed: NormalizedItem[] = [];
  for (const item of newItems) {
    try {
      const url = safeCanonicalUrl(item.canonicalUrl, item.platform, item.upstreamId);
      const ok = await repo.claimDocumentAnalysis({
        canonicalUrlHash: canonicalUrlHash(url),
        analysisVersion: CONTENT_ANALYSIS_VERSION,
        ownerWorkerId: WORKER_ID_FOR_CLAIM,
        leaseMinutes: 5,
      });
      if (ok) claimed.push(item);
    } catch {
      claimed.push(item);
    }
  }
  return claimed;
}

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
      const claimableNewItems = await claimDocumentAnalyses(repo, newItems);
      const routed = claimableNewItems.length > 0
        ? await routeContentItems(claimableNewItems)
        : { outcomes: new Map(), stats: defaultSummaryStats("not_applicable") };
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
      : {
          shouldKeep: true,
          relevanceScore: row?.informationValueScore ?? undefined,
          retentionReason: undefined as string | undefined,
        };

    // Gate rejections: when a hard filter (exclude/required keyword) blocks
    // the document, set score low and reason explicit, but still record the
    // match so the UI can surface the decision.
    const gateBlocked = input.monitorRules && !monitorRetention.shouldKeep;

   linksByItem.set(itemId, {
     itemId,
     monitorId: input.monitorId,
     sourceItemId: storedSource?.id,
     matchedQuery: input.matchedQuery,
      relevanceScore: gateBlocked ? -1 : (monitorRetention.relevanceScore ?? undefined),
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

