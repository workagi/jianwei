import type { NormalizedItem } from "@/connectors/types";
import { db } from "@/db";
import {
  items,
  itemMatches,
  sourceItems,
  documentAnalysisClaims,
} from "@/db/schema";
import { createHash } from "node:crypto";
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
}

export interface IngestRepository {
  upsertItems(rows: IngestItemRow[]): Promise<UpsertedDocument[]>;
  upsertSourceItems(
    observations: IngestSourceObservation[],
  ): Promise<StoredSourceObservation[]>;
  linkMatches(links: IngestMatchLink[]): Promise<number>;
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
  }): Promise<boolean>;
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

export function createDrizzleIngestRepository(
  database: IngestDatabase = db,
): IngestRepository {
  return {
    async upsertItems(rows) {
      if (rows.length === 0) return [];

      const urls = [
        ...new Set(rows.map((r) => r.canonicalUrl).filter(Boolean)),
      ];
      type ExistingRow = UpsertedDocument & {
        publishedAt: Date;
        contentType: string | null;
        topicTags: string[] | null;
        informationValueScore: number | null;
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
            informationValueScore: items.informationValueScore,
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
            informationValueScore: row.informationValueScore,
          });
        }
      }

      const toInsert: IngestItemRow[] = [];
      const merged: UpsertedDocument[] = [];

      const mergeIntoExisting = async (
        row: IngestItemRow,
        hit: ExistingRow,
      ) => {
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
        if (row.publishedAt < hit.publishedAt)
          patch.publishedAt = row.publishedAt;
        if (!hit.contentType && row.contentType)
          patch.contentType = row.contentType;
        if (
          (!hit.topicTags || hit.topicTags.length === 0) &&
          row.topicTags?.length
        ) {
          patch.topicTags = row.topicTags;
        }
        // retentionReason/relevanceScore/retentionSource now live in item_matches exclusively
        // Only set informationValueScore if no value exists yet.
        // Once a model analysis produces a score, subsequent rule-only
        // re-observations of the same canonical URL must not downgrade it.
        if (row.informationValueScore != null && hit.informationValueScore == null)
          patch.informationValueScore = row.informationValueScore;

        await database.update(items).set(patch).where(eq(items.id, hit.id));
        merged.push({
          id: hit.id,
          platform: hit.platform,
          upstreamId: hit.upstreamId,
          canonicalUrl: hit.canonicalUrl,
        });
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

      if (toInsert.length === 0) return merged;

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

      const inserted: UpsertedDocument[] = allInserted.map((saved) => ({
        id: saved.id,
        platform: saved.platform as NormalizedItem["platform"],
        upstreamId: saved.upstreamId,
        canonicalUrl: saved.canonicalUrl,
      }));

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
            publishedAt: items.publishedAt,
            contentType: items.contentType,
            topicTags: items.topicTags,
            informationValueScore: items.informationValueScore,
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
            inserted.push({
              id: "",
              platform: row.platform,
              upstreamId: row.upstreamId,
              canonicalUrl: row.canonicalUrl,
            });
            continue;
          }
          remergePromises.push(mergeIntoExisting(row, winner));
        }
        await Promise.all(remergePromises);
      }

      return [...merged, ...inserted];
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
        })
        .returning({
          id: sourceItems.id,
          itemId: sourceItems.itemId,
          platform: sourceItems.platform,
          sourceProvider: sourceItems.sourceProvider,
          upstreamId: sourceItems.upstreamId,
        });
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
            rawPayload: sql`excluded."raw_payload"`,
            lastSeenAt: new Date(),
          },
        })
        .returning({ itemId: itemMatches.itemId });
      return result.length;
    },

    async claimDocumentAnalysis(input) {
      const result = await database
        .insert(documentAnalysisClaims)
        .values({
          canonicalUrlHash: input.canonicalUrlHash,
          analysisVersion: input.analysisVersion,
          ownerWorkerId: input.ownerWorkerId,
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
            status: sql`'claimed'`,
            claimedAt: sql`now()`,
            expiresAt: sql`now() + make_interval(mins => ${input.leaseMinutes})`,
          },
          where: and(
            sql`${documentAnalysisClaims.status} <> 'completed'`,
            lt(documentAnalysisClaims.expiresAt, new Date()),
          ),
        })
        .returning({ id: documentAnalysisClaims.id });
      return result.length > 0;
    },
  };
}

// Re-export helpers used by ingest-items.ts
export { sourceKey, sourceProvider, sourceIdentity, canonicalUrlHash };
