import type { NormalizedItem } from "@/connectors/types";
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
  matchObservationKey,
  WORKER_ID_FOR_CLAIM,
  type DocumentAnalysisClaim,
  type IngestItemRow,
  type IngestMatchLink,
  type IngestMatchObservation,
  type IngestSourceObservation,
  type IngestRepository,
} from "./repositories";

export { createDrizzleIngestRepository } from "./repositories";

export type { DocumentAnalysisClaim, IngestItemRow, IngestMatchLink, IngestMatchObservation, IngestSourceObservation, StoredSourceObservation, UpsertedDocument, IngestRepository } from "./repositories";

const FUTURE_SKEW_MS = 5 * 60 * 1000;

export function documentAnalysisClaimLeaseMinutes(
  raw = process.env.DOCUMENT_ANALYSIS_CLAIM_LEASE_MINUTES,
): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 30;
  return Math.min(120, Math.max(5, Math.ceil(parsed)));
}

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
 * batch collapse to the richest representation, so a short search snippet
 * cannot hide a full-text observation of the same document.
 */
function itemRow(item: NormalizedItem, now: Date): IngestItemRow {
  const canonical = safeCanonicalUrl(item.canonicalUrl, item.platform, item.upstreamId);
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
  return {
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
  };
}

function itemRowQuality(row: IngestItemRow): number {
  const bodyLength = row.bodyText.trim().length;
  const htmlLength = row.contentHtml?.trim().length ?? 0;
  const fullTextBonus = row.contentFetchStatus === "success" && htmlLength > 0 ? 1_000_000 : 0;
  return fullTextBonus
    + htmlLength * 2
    + bodyLength
    + (row.title?.trim() ? 2_000 : 0)
    + (row.authorName?.trim() || row.authorHandle?.trim() ? 500 : 0)
    + (row.imageUrls?.length ?? 0) * 100;
}

export function toItemRows(input: NormalizedItem[]): IngestItemRow[] {
  const now = new Date();
  const bySource = new Map<string, IngestItemRow>();
  for (const item of input) {
    const key = dedupeKey(item);
    const candidate = itemRow(item, now);
    const current = bySource.get(key);
    if (!current || itemRowQuality(candidate) > itemRowQuality(current)) {
      bySource.set(key, candidate);
    }
  }

  // `items.canonical_url` is globally unique. When several providers return the
  // same document in one batch, persist the richest representation rather than
  // whichever happened to arrive first. Source observations are still kept
  // independently from this document-level collapse.
  const byCanonicalUrl = new Map<string, IngestItemRow>();
  for (const candidate of bySource.values()) {
    const current = byCanonicalUrl.get(candidate.canonicalUrl);
    if (!current || itemRowQuality(candidate) > itemRowQuality(current)) {
      byCanonicalUrl.set(candidate.canonicalUrl, candidate);
    }
  }
  return [...byCanonicalUrl.values()];
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
  signal?: AbortSignal;
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
  analysisClaims: DocumentAnalysisClaim[];
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
  signal?: AbortSignal,
): Promise<{ items: NormalizedItem[]; claims: DocumentAnalysisClaim[] }> {
  if (!repo.claimDocumentAnalysis) return { items: newItems, claims: [] };
  if (!repo.completeDocumentAnalyses || !repo.releaseDocumentAnalyses) {
    throw new Error("DOCUMENT_ANALYSIS_CLAIM_COMPLETION_UNAVAILABLE");
  }
  const claimed: NormalizedItem[] = [];
  const claims: DocumentAnalysisClaim[] = [];
  try {
    for (const item of newItems) {
      signal?.throwIfAborted();
      const url = safeCanonicalUrl(item.canonicalUrl, item.platform, item.upstreamId);
      const claim = await repo.claimDocumentAnalysis({
        canonicalUrlHash: canonicalUrlHash(url),
        analysisVersion: CONTENT_ANALYSIS_VERSION,
        ownerWorkerId: WORKER_ID_FOR_CLAIM,
        leaseMinutes: documentAnalysisClaimLeaseMinutes(),
      });
      if (!claim) {
        // Do not keep claiming later documents after one is owned by another
        // worker. Returning a partially claimed batch would make the caller
        // repeatedly retry the same prefix while holding unrelated claims.
        throw new Error("DOCUMENT_ANALYSIS_IN_PROGRESS");
      }
      claimed.push(item);
      claims.push(claim);
    }
    return { items: claimed, claims };
  } catch (error) {
    if (claims.length > 0) {
      const released = await repo.releaseDocumentAnalyses(claims);
      if (released !== claims.length) throw new Error("DOCUMENT_ANALYSIS_CLAIM_LOST");
    }
    throw error;
  }
}

export async function prepareIngest(
  repo: IngestRepository,
  input: IngestInput,
): Promise<PreparedIngest> {
  const rows = toItemRows(input.items);
  input.signal?.throwIfAborted();
  if (rows.length === 0) {
    return { input, rows, summary: defaultSummaryStats("not_applicable"), analysisClaims: [] };
  }

  // Only unseen items enter the model route, preventing repeated API spend.
  // Every new item receives a durable route status, including disabled,
  // skipped and failed outcomes, so later retries can target exact rows.
  let summary = defaultSummaryStats("not_applicable");
  let analysisClaims: DocumentAnalysisClaim[] = [];
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
    input.signal?.throwIfAborted();
    const inputBySourceIdentity = new Map<string, NormalizedItem>();
    const inputRowNow = new Date();
    for (const item of input.items) {
      const identity = sourceIdentity(item.platform, sourceProvider(item), item.upstreamId);
      const current = inputBySourceIdentity.get(identity);
      if (!current || itemRowQuality(itemRow(item, inputRowNow)) > itemRowQuality(itemRow(current, inputRowNow))) {
        inputBySourceIdentity.set(identity, item);
      }
    }
    // Analyse exactly the quality winner selected for each document row. Using
    // the original input order here could let a short duplicate claim the URL,
    // while the richer persisted row received no route outcome and stayed
    // pending forever.
    const newItems = rows.flatMap((row) => {
      const identity = sourceIdentity(
        row.platform as NormalizedItem["platform"],
        row.sourceProvider?.trim() || String(row.platform),
        row.upstreamId,
      );
      if (existingUpstream.has(identity) || existingUrls.has(row.canonicalUrl)) return [];
      const item = inputBySourceIdentity.get(identity);
      return item ? [item] : [];
    });
    if (newItems.length) {
      try {
        const claimed = await claimDocumentAnalyses(repo, newItems, input.signal);
        analysisClaims = claimed.claims;
        input.signal?.throwIfAborted();
        const routed = claimed.items.length > 0
          ? await routeContentItems(claimed.items, input.signal)
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
      } catch (error) {
        if (analysisClaims.length > 0) {
          const releaseClaims = repo.releaseDocumentAnalyses;
          if (!releaseClaims) throw new Error("DOCUMENT_ANALYSIS_CLAIM_RELEASE_UNAVAILABLE");
          const released = await releaseClaims(analysisClaims);
          if (released !== analysisClaims.length) throw new Error("DOCUMENT_ANALYSIS_CLAIM_LOST");
          analysisClaims = [];
        }
        throw error;
      }
    }
  }

  return { input, rows, summary, analysisClaims };
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
  const { input, rows, summary, analysisClaims } = prepared;
  if (rows.length === 0) {
    return { itemsUpserted: 0, matchesInserted: 0, summary };
  }

  const upserted = await repo.upsertItems(rows);

  // Map every provider observation to the canonical document. URL-merged rows
  // keep a historical identity on `items`, while `source_items` preserves all
  // incoming provider/upstream identities independently.
  const rowByIdentity = new Map(rows.map((r) => [
    sourceIdentity(
      r.platform as NormalizedItem["platform"],
      r.sourceProvider?.trim() || String(r.platform),
      r.upstreamId,
    ),
    r,
  ]));
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
  const matchObservationsByKey = new Map<string, IngestMatchObservation>();
  for (const observation of observations) {
    const storedSource = storedSourceByIdentity.get(sourceIdentity(
      observation.platform,
      observation.sourceProvider,
      observation.upstreamId,
    ));
    const itemId = storedSource?.itemId ?? observation.itemId;
    const observationKey = matchObservationKey({
      matchItemId: itemId,
      matchMonitorId: input.monitorId,
      sourceItemId: storedSource?.id,
      collectionRunId: input.runId,
      matchedQuery: input.matchedQuery,
    });
    matchObservationsByKey.set(observationKey, {
      observationKey,
      matchItemId: itemId,
      matchMonitorId: input.monitorId,
      sourceItemId: storedSource?.id,
      collectionRunId: input.runId,
      matchedQuery: input.matchedQuery,
      rawPayload: observation.rawPayload,
    });
    if (linksByItem.has(itemId)) continue;
    const canonicalDocument = documentByUrl.get(observation.sourceUrl)
      ?? documentByLegacySource.get(sourceKey(observation.platform, observation.upstreamId));
    const row = rowByIdentity.get(sourceIdentity(
      observation.platform,
      observation.sourceProvider,
      observation.upstreamId,
    ))
      ?? rowByUrl.get(observation.sourceUrl)
      ?? rowByUpstream.get(sourceKey(observation.platform, observation.upstreamId));

    // Derive per-monitor relevance and retention from document analysis +
    // monitor rules. This is the MonitorMatchAnalysis layer: each monitor
    // evaluates the same document differently based on its keywords, content
    // type filters and topic preferences.
    const monitorRetention = input.monitorRules
      ? deriveMonitorRetention(input.monitorRules, {
          contentType: canonicalDocument?.contentType ?? row?.contentType ?? "opinion",
          topicTags: canonicalDocument?.topicTags ?? row?.topicTags ?? [],
          summary: canonicalDocument?.aiSummary ?? row?.aiSummary ?? undefined,
          informationValueScore: canonicalDocument?.informationValueScore
            ?? row?.informationValueScore
            ?? undefined,
          title: canonicalDocument?.title ?? row?.title ?? undefined,
          bodyText: canonicalDocument?.bodyText ?? row?.bodyText ?? undefined,
        })
      : {
          shouldKeep: true,
          relevanceScore: canonicalDocument?.informationValueScore
            ?? row?.informationValueScore
            ?? undefined,
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
      retentionStatus: gateBlocked ? "gate_blocked" : "kept",
      analysisStatus: canonicalDocument?.analysisStatus ?? row?.analysisStatus ?? undefined,
      analysisVersion: canonicalDocument?.analysisVersion ?? row?.analysisVersion ?? undefined,
      rawPayload: observation.rawPayload,
      collectionRunId: input.runId,
    });
  }

  const matchesInserted = await repo.linkMatches([...linksByItem.values()]);
  await repo.insertMatchObservations([...matchObservationsByKey.values()]);

  // A claim is only completed after the document, source, match, and discovery
  // evidence all persist. The worker supplies a transaction-bound repository,
  // so a lost/reclaimed claim rolls this entire commit back instead of allowing
  // an old analysis owner to publish stale results.
  if (analysisClaims.length > 0) {
    if (!repo.completeDocumentAnalyses) {
      throw new Error("DOCUMENT_ANALYSIS_CLAIM_COMPLETION_UNAVAILABLE");
    }
    const completed = await repo.completeDocumentAnalyses(analysisClaims);
    if (completed !== analysisClaims.length) {
      throw new Error("DOCUMENT_ANALYSIS_CLAIM_LOST");
    }
  }
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
