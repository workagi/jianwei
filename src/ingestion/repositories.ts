import type { NormalizedItem } from "@/connectors/types";
import { db } from "@/db";
import {
  items,
  itemMatches,
  sourceItems,
  documentAnalysisClaims,
  monitorMatchObservations,
} from "@/db/schema";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createStructuredLogger } from "@/lib/structured-log";

const ingestionLog = createStructuredLogger({ service: "ingestion" });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type IngestDatabase = PostgresJsDatabase<any>;

/** Insert-ready row shape for the `items` table. */
export type IngestItemRow = typeof items.$inferInsert;

export interface IngestMatchLink {
  itemId: string;
  monitorId: string;
  sourceItemId?: string;
  matchedQuery?: string;
  relevanceScore?: number;
  retentionReason?: string;
  retentionSource?: string;
  retentionStatus: "kept" | "gate_blocked" | "pending" | "error";
  analysisVersion?: string;
  collectionRunId?: string;
  analysisStatus?: string;
  rawPayload: Record<string, unknown>;
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

export interface IngestMatchObservation {
  observationKey: string;
  matchItemId: string;
  matchMonitorId: string;
  sourceItemId?: string;
  collectionRunId?: string;
  matchedQuery?: string;
  rawPayload: Record<string, unknown>;
}

export interface DocumentAnalysisClaim {
  id: string;
  canonicalUrlHash: string;
  analysisVersion: string;
  ownerWorkerId: string;
  claimToken: string;
}

export interface StoredSourceObservation {
  id: string;
  itemId: string;
  platform: string;
  sourceProvider: string;
  upstreamId: string;
}

export interface UpsertedDocument {
  id: string;
  platform: string;
  upstreamId: string;
  canonicalUrl: string;
  // Final persisted document analysis.  Callers must evaluate monitor rules
  // against the canonical row, not the short observation that happened to
  // trigger this ingest.
  title?: string | null;
  bodyText?: string | null;
  aiSummary?: string | null;
  contentType?: string | null;
  topicTags?: string[] | null;
  informationValueScore?: number | null;
  analysisStatus?: string | null;
  analysisVersion?: string | null;
}

export interface IngestRepository {
  upsertItems(rows: IngestItemRow[]): Promise<UpsertedDocument[]>;
  upsertSourceItems(
    observations: IngestSourceObservation[],
  ): Promise<StoredSourceObservation[]>;
  linkMatches(links: IngestMatchLink[]): Promise<number>;
  insertMatchObservations(observations: IngestMatchObservation[]): Promise<number>;
  findExistingSourceKeys(
    sources: Array<{
      platform: NormalizedItem["platform"];
      sourceProvider: string;
      upstreamId: string;
    }>,
  ): Promise<Set<string>>;
  findExistingCanonicalUrls(canonicalUrls: string[]): Promise<Set<string>>;
  claimDocumentAnalysis?(input: {
    canonicalUrlHash: string;
    analysisVersion: string;
    ownerWorkerId: string;
    leaseMinutes: number;
  }): Promise<DocumentAnalysisClaim | null>;
  completeDocumentAnalyses?(claims: DocumentAnalysisClaim[]): Promise<number>;
  releaseDocumentAnalyses?(claims: DocumentAnalysisClaim[]): Promise<number>;
}

export const WORKER_ID_FOR_CLAIM =
  process.env.WORKER_ID?.trim() ||
  "ingest-" + Math.random().toString(36).slice(2, 8);

function sourceKey(platform: string, upstreamId: string): string {
  return `${platform}|${upstreamId}`;
}

function sourceProvider(item: NormalizedItem): string {
  return item.sourceProvider?.trim() || item.platform;
}

function sourceIdentity(
  platform: string,
  provider: string,
  upstreamId: string,
): string {
  return `${platform}:${provider}:${upstreamId}`;
}

function canonicalUrlHash(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 32);
}

export function matchObservationKey(input: {
  matchItemId: string;
  matchMonitorId: string;
  sourceItemId?: string;
  collectionRunId?: string;
  matchedQuery?: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify([
      input.matchItemId,
      input.matchMonitorId,
      input.sourceItemId ?? "",
      input.collectionRunId ?? "",
      input.matchedQuery?.trim() ?? "",
    ]))
    .digest("hex");
}

const ANALYSIS_STATUS_RANK: Record<string, number> = {
  pending: 0,
  disabled: 1,
  skipped: 1,
  failed: 2,
  partial: 3,
  success: 4,
};

export function createDrizzleIngestRepository(
  database: IngestDatabase = db,
): IngestRepository {
  const loadFinalDocuments = async (urls: string[]): Promise<UpsertedDocument[]> => {
    const uniqueUrls = [...new Set(urls.filter(Boolean))];
    if (uniqueUrls.length === 0) return [];
    const rows = await database
      .select({
        id: items.id,
        platform: items.platform,
        upstreamId: items.upstreamId,
        canonicalUrl: items.canonicalUrl,
        title: items.title,
        bodyText: items.bodyText,
        aiSummary: items.aiSummary,
        contentType: items.contentType,
        topicTags: items.topicTags,
        informationValueScore: items.informationValueScore,
        analysisStatus: items.analysisStatus,
        analysisVersion: items.analysisVersion,
      })
      .from(items)
      .where(inArray(items.canonicalUrl, uniqueUrls));
    return rows.map((row) => ({
      ...row,
      platform: row.platform as NormalizedItem["platform"],
      topicTags: row.topicTags ?? [],
    }));
  };

  return {
    async upsertItems(rows) {
      if (rows.length === 0) return [];

      const urls = [
        ...new Set(rows.map((r) => r.canonicalUrl).filter(Boolean)),
      ];
      type ExistingRow = UpsertedDocument;
      const existingByUrl = new Map<string, ExistingRow>();
      if (urls.length) {
        const existing = await database
          .select({
            id: items.id,
            platform: items.platform,
            upstreamId: items.upstreamId,
            canonicalUrl: items.canonicalUrl,
          })
          .from(items)
          .where(inArray(items.canonicalUrl, urls));
        for (const row of existing) {
          existingByUrl.set(row.canonicalUrl, {
            id: row.id,
            platform: row.platform as NormalizedItem["platform"],
            upstreamId: row.upstreamId,
            canonicalUrl: row.canonicalUrl,
          });
        }
      }

      const toInsert: IngestItemRow[] = [];

      const mergeIntoExisting = async (
        row: IngestItemRow,
        hit: ExistingRow,
      ) => {
        const incomingBody = row.bodyText.trim();
        const incomingImages = JSON.stringify(row.imageUrls ?? []);
        const incomingHtml = row.contentHtml?.trim() ?? "";
        const incomingPublishedAt = row.publishedAt.toISOString();
        const incomingContentFetchedAt = row.contentFetchedAt?.toISOString() ?? null;
        const incomingHtmlWins = sql`(
          ${items.contentHtml} is null
          or btrim(${items.contentHtml}) = ''
          or (
            ${row.contentFetchStatus === "success"}
            and ${items.contentFetchStatus} is distinct from 'success'
          )
          or length(${incomingHtml}) > length(coalesce(btrim(${items.contentHtml}), ''))
        )`;

        // Content observations merge monotonically. Empty or shorter snippets
        // cannot erase a title, full body, media list, or successful full-text
        // payload that another provider already persisted.
        await database.update(items).set({
          authorId: sql`coalesce(nullif(btrim(${items.authorId}), ''), nullif(btrim(${row.authorId ?? null}), ''))`,
          authorName: sql`coalesce(nullif(btrim(${items.authorName}), ''), nullif(btrim(${row.authorName ?? null}), ''))`,
          authorHandle: sql`coalesce(nullif(btrim(${items.authorHandle}), ''), nullif(btrim(${row.authorHandle ?? null}), ''))`,
          avatarUrl: sql`coalesce(nullif(btrim(${items.avatarUrl}), ''), nullif(btrim(${row.avatarUrl ?? null}), ''))`,
          sourceProvider: sql`coalesce(nullif(btrim(${items.sourceProvider}), ''), nullif(btrim(${row.sourceProvider ?? null}), ''))`,
          title: sql`coalesce(nullif(btrim(${items.title}), ''), nullif(btrim(${row.title ?? null}), ''))`,
          bodyText: sql`case
            when length(${incomingBody}) > length(btrim(${items.bodyText})) then ${row.bodyText}
            else ${items.bodyText}
          end`,
          imageUrls: sql`case
            when jsonb_array_length(${incomingImages}::jsonb) > jsonb_array_length(${items.imageUrls})
              then ${incomingImages}::jsonb
            else ${items.imageUrls}
          end`,
          contentHash: sql`case
            when length(${incomingBody}) > length(btrim(${items.bodyText})) then ${row.contentHash}
            else ${items.contentHash}
          end`,
          // Values embedded in a raw SQL expression do not receive Drizzle's
          // timestamp column encoder. Pass ISO text and cast explicitly so the
          // postgres-js driver never receives a bare Date object.
          publishedAt: sql`least(${items.publishedAt}, ${incomingPublishedAt}::timestamptz)`,
          contentType: sql`coalesce(${items.contentType}, ${row.contentType ?? null})`,
          topicTags: sql`case
            when jsonb_array_length(${items.topicTags}) = 0 then ${JSON.stringify(row.topicTags ?? [])}::jsonb
            else ${items.topicTags}
          end`,
          informationValueScore: sql`coalesce(${items.informationValueScore}, ${row.informationValueScore ?? null})`,
          ...(incomingHtml
            ? {
                contentHtml: sql`case when ${incomingHtmlWins} then ${row.contentHtml} else ${items.contentHtml} end`,
                contentProvider: sql`case when ${incomingHtmlWins} then ${row.contentProvider ?? null} else ${items.contentProvider} end`,
                contentFetchStatus: sql`case when ${incomingHtmlWins} then ${row.contentFetchStatus ?? null} else ${items.contentFetchStatus} end`,
                contentFetchError: sql`case when ${incomingHtmlWins} then ${row.contentFetchError ?? null} else ${items.contentFetchError} end`,
                contentFetchedAt: sql`case when ${incomingHtmlWins} then ${incomingContentFetchedAt}::timestamptz else ${items.contentFetchedAt} end`,
              }
            : {}),
          updatedAt: new Date(),
        }).where(eq(items.id, hit.id));

        const incomingStatus = String(row.analysisStatus ?? "pending");
        const incomingRank = ANALYSIS_STATUS_RANK[incomingStatus] ?? 0;
        if (incomingRank > 0) {
          const currentRank = sql`case ${items.analysisStatus}
            when 'success' then 4
            when 'partial' then 3
            when 'failed' then 2
            when 'disabled' then 1
            when 'skipped' then 1
            else 0
          end`;
          const incomingSummary = row.aiSummary?.trim() || null;
          await database.update(items).set({
            aiSummary: sql`coalesce(${incomingSummary}, ${items.aiSummary})`,
            translatedTitle: sql`coalesce(${row.translatedTitle?.trim() || null}, ${items.translatedTitle})`,
            contentType: row.contentType ?? null,
            topicTags: row.topicTags ?? [],
            informationValueScore: row.informationValueScore ?? null,
            editorialReason: sql`coalesce(${row.editorialReason ?? null}, ${items.editorialReason})`,
            analysisStatus: incomingStatus,
            analysisProvider: row.analysisProvider ?? null,
            analysisModel: row.analysisModel ?? null,
            analysisVersion: row.analysisVersion ?? null,
            analysisAttempts: row.analysisAttempts ?? 0,
            analysisErrorCode: row.analysisErrorCode ?? null,
            analysisErrorMessage: row.analysisErrorMessage ?? null,
            analyzedAt: row.analyzedAt ?? null,
            updatedAt: new Date(),
          }).where(and(
            eq(items.id, hit.id),
            sql`(
              ${incomingRank} > (${currentRank})
              or (
                ${incomingRank} = (${currentRank})
                and ${incomingSummary}::text is not null
                and (${items.aiSummary} is null or btrim(${items.aiSummary}) = '')
              )
            )`,
          ));
        }
      };

      // Phase 1: update already-known documents in parallel
      const mergePromises: Promise<void>[] = [];
      for (const row of rows) {
        const hit = existingByUrl.get(row.canonicalUrl);
        if (!hit) {
          toInsert.push(row);
          continue;
        }
        mergePromises.push(mergeIntoExisting(row, hit));
      }
      await Promise.all(mergePromises);

      if (toInsert.length === 0) return loadFinalDocuments(urls);

      // Phase 2: batch-insert all new rows
      const allInserted = await database
        .insert(items)
        .values(toInsert as typeof items.$inferInsert[])
        .onConflictDoNothing()
        .returning({
          id: items.id,
          platform: items.platform,
          upstreamId: items.upstreamId,
          canonicalUrl: items.canonicalUrl,
        });

      // Phase 3: batch-resolve conflicts
      const insertedKeys = new Set(
        allInserted.map((s) => `${s.platform}|${s.upstreamId}`),
      );
      const conflictRows = toInsert.filter(
        (row) => !insertedKeys.has(`${row.platform}|${row.upstreamId}`),
      );
      if (conflictRows.length > 0) {
        const conflictPlatformUpstream = conflictRows.map((r) =>
          and(
            eq(items.platform, r.platform),
            eq(items.upstreamId, r.upstreamId),
          ),
        );
        const conflictUrls = conflictRows
          .filter((r) => r.canonicalUrl)
          .map((r) => eq(items.canonicalUrl, r.canonicalUrl));

        const allConditions = [...conflictPlatformUpstream, ...conflictUrls];
        const winners = await database
          .select({
            id: items.id,
            platform: items.platform,
            upstreamId: items.upstreamId,
            canonicalUrl: items.canonicalUrl,
          })
          .from(items)
          .where(or(...allConditions));

        const winnerByKey = new Map<string, ExistingRow>();
        for (const w of winners) {
          winnerByKey.set(`${w.platform}|${w.upstreamId}`, {
            ...w,
            platform: w.platform as NormalizedItem["platform"],
          });
          if (w.canonicalUrl) {
            winnerByKey.set(w.canonicalUrl, {
              ...w,
              platform: w.platform as NormalizedItem["platform"],
            });
          }
        }

        const remergePromises: Promise<void>[] = [];
        for (const row of conflictRows) {
          const winner =
            winnerByKey.get(`${row.platform}|${row.upstreamId}`) ??
            (row.canonicalUrl
              ? winnerByKey.get(row.canonicalUrl)
              : undefined);
          if (!winner) {
            continue;
          }
          remergePromises.push(mergeIntoExisting(row, winner));
        }
        await Promise.all(remergePromises);
      }

      // Re-read the winners after every insert/merge.  This returns the
      // canonical document state (including authoritative analysis) instead
      // of the incoming provider observation that happened to win the race.
      return loadFinalDocuments(urls);
    },

    async upsertSourceItems(observations) {
      if (observations.length === 0) return [];
      const now = new Date();
      await database
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
          target: [
            sourceItems.platform,
            sourceItems.sourceProvider,
            sourceItems.upstreamId,
          ],
          set: {
            sourceUrl: sql`excluded."source_url"`,
            authorId: sql`coalesce(excluded."author_id", "source_items"."author_id")`,
            authorName: sql`coalesce(excluded."author_name", "source_items"."author_name")`,
            authorHandle: sql`coalesce(excluded."author_handle", "source_items"."author_handle")`,
            avatarUrl: sql`coalesce(excluded."avatar_url", "source_items"."avatar_url")`,
            rawPayload: sql`excluded."raw_payload"`,
            publishedAt: sql`excluded."published_at"`,
            lastSeenAt: now,
          },
          // A provider/upstream identity belongs to exactly one canonical
          // document. If canonicalization later disagrees, preserve the whole
          // original evidence row instead of combining document A's itemId
          // with document B's URL/payload.
          setWhere: sql`"source_items"."item_id" = excluded."item_id"`,
        })
        .returning({ id: sourceItems.id });

      // Re-read every identity. A fenced conflict deliberately returns no row
      // from the UPSERT, but callers still need the immutable stored binding
      // so they can reject the incoming observation without guessing.
      const returned = await database
        .select({
          id: sourceItems.id,
          itemId: sourceItems.itemId,
          platform: sourceItems.platform,
          sourceProvider: sourceItems.sourceProvider,
          upstreamId: sourceItems.upstreamId,
        })
        .from(sourceItems)
        .where(or(...observations.map((obs) => and(
          eq(sourceItems.platform, obs.platform),
          eq(sourceItems.sourceProvider, obs.sourceProvider),
          eq(sourceItems.upstreamId, obs.upstreamId),
        ))));
      for (const {
        itemId,
        platform,
        sourceProvider: sp,
        upstreamId,
      } of returned) {
        const input = observations.find(
          (obs) =>
            obs.platform === platform &&
            obs.sourceProvider === sp &&
            obs.upstreamId === upstreamId,
        );
        if (input && input.itemId !== itemId) {
          ingestionLog.warn("source_items.rebind_rejected", {
            platform,
            sourceProvider: sp,
            upstreamId,
            previousDocumentId: itemId,
            currentDocumentId: input.itemId,
          });
        }
      }
      return returned.map((row) => ({
        ...row,
        platform: row.platform as NormalizedItem["platform"],
      }));
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
        .where(
          or(
            ...sources.map((s) =>
              and(
                eq(sourceItems.platform, s.platform),
                eq(sourceItems.sourceProvider, s.sourceProvider),
                eq(sourceItems.upstreamId, s.upstreamId),
              ),
            ),
          ),
        );
      return new Set(
        existingSources.map((s) =>
          sourceIdentity(
            s.platform as NormalizedItem["platform"],
            s.sourceProvider,
            s.upstreamId,
          ),
        ),
      );
    },

    async findExistingCanonicalUrls(canonicalUrls) {
      if (canonicalUrls.length === 0) return new Set();
      const existingItems = await database
        .select({ canonicalUrl: items.canonicalUrl })
        .from(items)
        .where(inArray(items.canonicalUrl, canonicalUrls));
      return new Set(existingItems.map((item) => item.canonicalUrl));
    },

    async linkMatches(links) {
      if (links.length === 0) return 0;
      const result = await database
        .insert(itemMatches)
        .values(
          links.map((link) => ({
            itemId: link.itemId,
            monitorId: link.monitorId,
            sourceItemId: link.sourceItemId ?? null,
            matchedQuery: link.matchedQuery,
            relevanceScore: link.relevanceScore,
            retentionReason: link.retentionReason,
            retentionSource: link.retentionSource,
            retentionStatus: link.retentionStatus,
            analysisStatus: link.analysisStatus,
            analysisVersion: link.analysisVersion,
            rawPayload: link.rawPayload,
          })),
        )
        .onConflictDoUpdate({
          target: [itemMatches.itemId, itemMatches.monitorId],
          set: {
            sourceItemId: sql`excluded."source_item_id"`,
            relevanceScore: sql`coalesce(excluded."relevance_score", "item_matches"."relevance_score")`,
            retentionReason: sql`coalesce(excluded."retention_reason", "item_matches"."retention_reason")`,
            retentionSource: sql`coalesce(excluded."retention_source", "item_matches"."retention_source")`,
            retentionStatus: sql`excluded."retention_status"`,
            // A later provider observation is often only a short/pending
            // snippet.  Never let that downgrade an already authoritative
            // monitor analysis (success > partial > failed > disabled >
            // pending).  The same decision must guard its version.
            analysisStatus: sql`case
              when case excluded."analysis_status"
                when 'success' then 4
                when 'partial' then 3
                when 'failed' then 2
                when 'disabled' then 1
                when 'skipped' then 1
                else 0
              end > case "item_matches"."analysis_status"
                when 'success' then 4
                when 'partial' then 3
                when 'failed' then 2
                when 'disabled' then 1
                when 'skipped' then 1
                else 0
              end
              then excluded."analysis_status"
              else "item_matches"."analysis_status"
            end`,
            analysisVersion: sql`case
              when case excluded."analysis_status"
                when 'success' then 4
                when 'partial' then 3
                when 'failed' then 2
                when 'disabled' then 1
                when 'skipped' then 1
                else 0
              end > case "item_matches"."analysis_status"
                when 'success' then 4
                when 'partial' then 3
                when 'failed' then 2
                when 'disabled' then 1
                when 'skipped' then 1
                else 0
              end
              then excluded."analysis_version"
              else "item_matches"."analysis_version"
            end`,
            rawPayload: sql`excluded."raw_payload"`,
            lastSeenAt: new Date(),
          },
        })
        .returning({ itemId: itemMatches.itemId });
      return result.length;
    },

    async insertMatchObservations(observations) {
      if (observations.length === 0) return 0;
      const inserted = await database
        .insert(monitorMatchObservations)
        .values(observations.map((observation) => ({
          observationKey: observation.observationKey,
          matchItemId: observation.matchItemId,
          matchMonitorId: observation.matchMonitorId,
          sourceItemId: observation.sourceItemId ?? null,
          collectionRunId: observation.collectionRunId ?? null,
          matchedQuery: observation.matchedQuery,
          rawPayload: observation.rawPayload,
        })))
        .onConflictDoNothing({ target: monitorMatchObservations.observationKey })
        .returning({ id: monitorMatchObservations.id });
      return inserted.length;
    },

    async claimDocumentAnalysis(input) {
      const claimToken = randomUUID();
      const result = await database
        .insert(documentAnalysisClaims)
        .values({
          canonicalUrlHash: input.canonicalUrlHash,
          analysisVersion: input.analysisVersion,
          ownerWorkerId: input.ownerWorkerId,
          claimToken,
          status: "claimed",
          claimedAt: new Date(),
          expiresAt: new Date(Date.now() + input.leaseMinutes * 60_000),
        })
        .onConflictDoUpdate({
          target: [
            documentAnalysisClaims.canonicalUrlHash,
            documentAnalysisClaims.analysisVersion,
          ],
          set: {
            ownerWorkerId: sql`excluded."owner_worker_id"`,
            claimToken: sql`excluded."claim_token"`,
            status: sql`'claimed'`,
            claimedAt: sql`now()`,
            expiresAt: sql`now() + (${String(input.leaseMinutes)} || ' minutes')::interval`,
          },
          where: and(
            sql`${documentAnalysisClaims.status} <> 'completed'`,
            lt(documentAnalysisClaims.expiresAt, new Date()),
          ),
        })
        .returning({
          id: documentAnalysisClaims.id,
          canonicalUrlHash: documentAnalysisClaims.canonicalUrlHash,
          analysisVersion: documentAnalysisClaims.analysisVersion,
          ownerWorkerId: documentAnalysisClaims.ownerWorkerId,
          claimToken: documentAnalysisClaims.claimToken,
        });
      return result[0] ?? null;
    },

    async completeDocumentAnalyses(claims) {
      let completed = 0;
      for (const claim of claims) {
        const result = await database
          .update(documentAnalysisClaims)
          .set({
            status: "completed",
            completedAt: new Date(),
          })
          .where(and(
            eq(documentAnalysisClaims.id, claim.id),
            eq(documentAnalysisClaims.canonicalUrlHash, claim.canonicalUrlHash),
            eq(documentAnalysisClaims.analysisVersion, claim.analysisVersion),
            eq(documentAnalysisClaims.ownerWorkerId, claim.ownerWorkerId),
            eq(documentAnalysisClaims.claimToken, claim.claimToken),
            eq(documentAnalysisClaims.status, "claimed"),
          ))
          .returning({ id: documentAnalysisClaims.id });
        if (result.length !== 1) {
          throw new Error("DOCUMENT_ANALYSIS_CLAIM_LOST");
        }
        completed += 1;
      }
      return completed;
    },

    async releaseDocumentAnalyses(claims) {
      let released = 0;
      for (const claim of claims) {
        const result = await database
          .delete(documentAnalysisClaims)
          .where(and(
            eq(documentAnalysisClaims.id, claim.id),
            eq(documentAnalysisClaims.ownerWorkerId, claim.ownerWorkerId),
            eq(documentAnalysisClaims.claimToken, claim.claimToken),
            eq(documentAnalysisClaims.status, "claimed"),
          ))
          .returning({ id: documentAnalysisClaims.id });
        released += result.length;
      }
      return released;
    },
  };
}

// Re-export helpers used by ingest-items.ts
export { sourceKey, sourceProvider, sourceIdentity, canonicalUrlHash };
