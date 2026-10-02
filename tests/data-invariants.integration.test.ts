import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import {
  connectors,
  items,
  itemMatches,
  monitors,
  sourceItems,
  collectionRuns,
  monitorMatchObservations,
  documentAnalysisClaims,
} from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { createDrizzleIngestRepository, ingest } from "@/ingestion/ingest-items";
import type { NormalizedItem } from "@/connectors/types";
import { countItems, getItems } from "@/db/queries";
import { documentContentHash } from "@/ingestion/content-revisions";

const describeDatabase = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;

const cleanupIds: { connectors: string[]; monitors: string[]; items: string[] } = {
  connectors: [],
  monitors: [],
  items: [],
};

afterEach(async () => {
  for (const id of cleanupIds.monitors.splice(0)) {
    await db.delete(collectionRuns).where(eq(collectionRuns.monitorId, id));
    await db.delete(monitors).where(eq(monitors.id, id));
  }
  for (const id of cleanupIds.connectors.splice(0)) {
    await db.delete(connectors).where(eq(connectors.id, id));
  }
  for (const id of cleanupIds.items.splice(0)) {
    await db.delete(monitorMatchObservations).where(eq(monitorMatchObservations.matchItemId, id));
    await db.delete(itemMatches).where(eq(itemMatches.itemId, id));
    await db.delete(sourceItems).where(eq(sourceItems.itemId, id));
    await db.delete(items).where(eq(items.id, id));
  }
});

describeDatabase("fencing token prevents stale worker writes", () => {
  it("rejects monitor update with wrong lease epoch", async () => {
    // Simulate a stale worker trying to update a monitor after losing its lease
    const [connector] = await db.insert(connectors).values({
      platform: "web_search",
      provider: "brave",
      name: "fence-test",
    }).returning({ id: connectors.id });
    cleanupIds.connectors.push(connector.id);

    const [mon] = await db.insert(monitors).values({
      platform: "web_search",
      connectorId: connector.id,
      name: "fence-test-monitor",
      config: { query: "test" },
      leaseOwner: "worker-a",
      leaseEpoch: 5,
      leaseUntil: sql`now() + interval '5 minutes'`,
      nextRunAt: new Date(),
    }).returning({ id: monitors.id });
    cleanupIds.monitors.push(mon.id);

    // Worker B claims it (epoch becomes 6)
    await db.update(monitors).set({
      leaseOwner: "worker-b",
      leaseEpoch: 6,
      leaseUntil: sql`now() + interval '5 minutes'`,
    }).where(eq(monitors.id, mon.id));

    // Worker A (epoch 5) tries to update — should affect 0 rows
    const result = await db.update(monitors).set({
      lastSuccessAt: new Date(),
      leaseOwner: null,
      leaseUntil: null,
    }).where(and(
      eq(monitors.id, mon.id),
      eq(monitors.leaseOwner, "worker-a"),
      eq(monitors.leaseEpoch, 5),
    )).returning({ id: monitors.id });

    // Verify 0 rows returned — fencing worked
    expect(result).toHaveLength(0);
    const [current] = await db.select({ leaseOwner: monitors.leaseOwner, leaseEpoch: monitors.leaseEpoch })
      .from(monitors).where(eq(monitors.id, mon.id));
    expect(current.leaseOwner).toBe("worker-b");
    expect(current.leaseEpoch).toBe(6);
  });
});

describeDatabase("canonical URL concurrent insert safety", () => {
  it("two workers inserting same canonical URL do not lose data", async () => {
    const repo = createDrizzleIngestRepository();
    const canonicalUrl = `https://example.com/concurrent-test-${randomUUID().slice(0, 8)}`;

    const itemA: NormalizedItem = {
      platform: "web_search",
      upstreamId: `up-a-${randomUUID().slice(0, 8)}`,
      canonicalUrl: canonicalUrl,
      text: "Worker A content",
      publishedAt: new Date(),
      imageUrls: [],
      raw: {},
    };

    const itemB: NormalizedItem = {
      platform: "web_search",
      upstreamId: `up-b-${randomUUID().slice(0, 8)}`,
      canonicalUrl: canonicalUrl,
      text: "Worker B content with more detail and extra information",
      publishedAt: new Date(),
      imageUrls: [],
      raw: {},
    };

    // Simulate concurrent insert: both try to insert the same canonical URL
    const rowsA = [{ platform: itemA.platform, upstreamId: itemA.upstreamId, canonicalUrl, bodyText: itemA.text, contentHash: randomUUID(), publishedAt: itemA.publishedAt, title: null, topicTags: [] }];
    const rowsB = [{ platform: itemB.platform, upstreamId: itemB.upstreamId, canonicalUrl, bodyText: itemB.text, contentHash: randomUUID(), publishedAt: itemB.publishedAt, title: null, topicTags: [] }];

    const [resultA, resultB] = await Promise.all([
      repo.upsertItems(rowsA as Parameters<typeof repo.upsertItems>[0]),
      repo.upsertItems(rowsB as Parameters<typeof repo.upsertItems>[0]),
    ]);

    // Both should succeed (no crash, no batch failure)
    expect(resultA.length).toBeGreaterThan(0);
    expect(resultB.length).toBeGreaterThan(0);

    // Only one document should exist (same canonical URL)
    const docs = await db.select({ id: items.id, canonicalUrl: items.canonicalUrl })
      .from(items).where(eq(items.canonicalUrl, canonicalUrl));
    expect(docs.length).toBe(1);

    cleanupIds.items.push(docs[0].id);
  });
});

describeDatabase("source_items itemId is immutable after first binding", () => {
  it("does not change itemId on re-insert with different canonical URL", async () => {
    const url1 = `https://example.com/doc-a-${randomUUID().slice(0, 8)}`;
    const url2 = `https://example.com/doc-b-${randomUUID().slice(0, 8)}`;

    // Insert first document
    const [docA] = await db.insert(items).values({
      platform: "web_search",
      upstreamId: `src-immu-a-${randomUUID().slice(0, 8)}`,
      canonicalUrl: url1,
      bodyText: "Document A",
      contentHash: randomUUID(),
      publishedAt: new Date(),
    }).returning({ id: items.id, canonicalUrl: items.canonicalUrl });
    cleanupIds.items.push(docA.id);

    // Insert second document
    const [docB] = await db.insert(items).values({
      platform: "web_search",
      upstreamId: `src-immu-b-${randomUUID().slice(0, 8)}`,
      canonicalUrl: url2,
      bodyText: "Document B",
      contentHash: randomUUID(),
      publishedAt: new Date(),
    }).returning({ id: items.id, canonicalUrl: items.canonicalUrl });
    cleanupIds.items.push(docB.id);

    // Create source_item bound to docA
    const sourceId = `source-immu-${randomUUID().slice(0, 8)}`;
    await db.insert(sourceItems).values({
      itemId: docA.id,
      platform: "web_search",
      sourceProvider: "brave",
      upstreamId: sourceId,
      sourceUrl: url1,
    });

    // Re-insert same source identity pointing to docB — should NOT rebind
    const repo = createDrizzleIngestRepository();
    const observations = [{
      itemId: docB.id,
      platform: "web_search" as const,
      sourceProvider: "brave",
      upstreamId: sourceId,
      sourceUrl: url2,
      authorId: undefined,
      authorName: undefined,
      authorHandle: undefined,
      avatarUrl: undefined,
      rawPayload: { document: "B" },
      publishedAt: new Date(),
    }];
    const stored = await repo.upsertSourceItems(observations);

    // Verify the entire evidence row is still docA. A partial update would
    // create a cross-document source chain (itemId=A, URL/payload=B).
    expect(stored.length).toBe(1);
    expect(stored[0].itemId).toBe(docA.id);
    expect(stored[0].itemId).not.toBe(docB.id);
    const [persistedSource] = await db.select({
      itemId: sourceItems.itemId,
      sourceUrl: sourceItems.sourceUrl,
      rawPayload: sourceItems.rawPayload,
    }).from(sourceItems).where(eq(sourceItems.upstreamId, sourceId));
    expect(persistedSource.itemId).toBe(docA.id);
    expect(persistedSource.sourceUrl).toBe(url1);
    expect(persistedSource.rawPayload).not.toMatchObject({ document: "B" });
  });
});

describeDatabase("collection_run attemptToken prevents stale attempt from overwriting", () => {
  it("stale attempt 1 cannot overwrite attempt 2 success", async () => {
    const [connector] = await db.insert(connectors).values({
      platform: "web_search",
      provider: "brave",
      name: "attempt-test",
    }).returning({ id: connectors.id });
    cleanupIds.connectors.push(connector.id);

    const [mon] = await db.insert(monitors).values({
      platform: "web_search",
      connectorId: connector.id,
      name: "attempt-test-monitor",
      config: { query: "test" },
      nextRunAt: new Date(),
    }).returning({ id: monitors.id });
    cleanupIds.monitors.push(mon.id);

    const runId = randomUUID();
    const attempt1Token = randomUUID();
    const attempt2Token = randomUUID();

    // Insert run
    await db.insert(collectionRuns).values({
      id: runId,
      monitorId: mon.id,
      scheduledFor: new Date(),
      idempotencyKey: `test-${randomUUID()}`,
      attempt: 1,
      attemptToken: attempt1Token,
      status: "running",
    });

    // Attempt 2 claims it
    await db.update(collectionRuns).set({
      attempt: 2,
      attemptToken: attempt2Token,
      status: "running",
    }).where(and(eq(collectionRuns.id, runId), eq(collectionRuns.attemptToken, attempt1Token)));

    // Attempt 1 tries to mark success — should affect 0 rows
    const staleUpdate = await db.update(collectionRuns).set({
      status: "success",
      finishedAt: new Date(),
    }).where(and(eq(collectionRuns.id, runId), eq(collectionRuns.attemptToken, attempt1Token)))
      .returning({ id: collectionRuns.id });

    expect(staleUpdate).toHaveLength(0);

    // Verify attempt 2 is still running (not overwritten)
    const [current] = await db.select({ status: collectionRuns.status, attempt: collectionRuns.attempt, attemptToken: collectionRuns.attemptToken })
      .from(collectionRuns).where(eq(collectionRuns.id, runId));
    expect(current.attempt).toBe(2);
    expect(current.attemptToken).toBe(attempt2Token);
    expect(current.status).toBe("running");
  });
});

describeDatabase("reader visibility follows explicit Gate decisions", () => {
  it("keeps blocked matches auditable without exposing them in the feed", async () => {
    const [connector] = await db.insert(connectors).values({
      platform: "web_search",
      provider: "brave",
      name: `reader-gate-${randomUUID()}`,
    }).returning({ id: connectors.id });
    cleanupIds.connectors.push(connector.id);

    const [monitor] = await db.insert(monitors).values({
      platform: "web_search",
      connectorId: connector.id,
      name: `reader-gate-monitor-${randomUUID()}`,
      config: { query: "AI" },
      nextRunAt: new Date(),
    }).returning({ id: monitors.id });
    cleanupIds.monitors.push(monitor.id);

    const insertedDocs = await db.insert(items).values([
      {
        platform: "web_search",
        upstreamId: `reader-kept-${randomUUID()}`,
        canonicalUrl: `https://example.com/reader-kept-${randomUUID()}`,
        title: "AI 产品更新",
        bodyText: "A kept document",
        contentHash: randomUUID(),
        publishedAt: new Date(),
      },
      {
        platform: "web_search",
        upstreamId: `reader-blocked-${randomUUID()}`,
        canonicalUrl: `https://example.com/reader-blocked-${randomUUID()}`,
        title: "AI 招聘信息",
        bodyText: "A blocked document",
        contentHash: randomUUID(),
        publishedAt: new Date(),
      },
    ]).returning({ id: items.id, canonicalUrl: items.canonicalUrl });
    cleanupIds.items.push(...insertedDocs.map((doc) => doc.id));

    const insertedSources = await db.insert(sourceItems).values(insertedDocs.map((doc, index) => ({
      itemId: doc.id,
      platform: "web_search" as const,
      sourceProvider: "brave",
      upstreamId: `reader-source-${index}-${randomUUID()}`,
      sourceUrl: doc.canonicalUrl,
    }))).returning({ id: sourceItems.id, itemId: sourceItems.itemId });

    await db.insert(itemMatches).values([
      {
        itemId: insertedDocs[0].id,
        monitorId: monitor.id,
        sourceItemId: insertedSources.find((source) => source.itemId === insertedDocs[0].id)?.id,
        retentionStatus: "kept",
        relevanceScore: 80,
      },
      {
        itemId: insertedDocs[1].id,
        monitorId: monitor.id,
        sourceItemId: insertedSources.find((source) => source.itemId === insertedDocs[1].id)?.id,
        retentionStatus: "gate_blocked",
        relevanceScore: -1,
        retentionReason: "命中排除词：招聘",
      },
    ]);

    const rows = await getItems({ monitorId: monitor.id, limit: 10 });
    expect(rows.map((row) => row.id)).toEqual([insertedDocs[0].id]);
    expect(await countItems({ monitorId: monitor.id })).toBe(1);

    const [blockedAuditRow] = await db.select({
      status: itemMatches.retentionStatus,
      reason: itemMatches.retentionReason,
    }).from(itemMatches).where(and(
      eq(itemMatches.itemId, insertedDocs[1].id),
      eq(itemMatches.monitorId, monitor.id),
    ));
    expect(blockedAuditRow).toEqual({
      status: "gate_blocked",
      reason: "命中排除词：招聘",
    });
  });
});

describeDatabase("ingestion merge invariants", () => {
  it("promotes authoritative analysis regardless of pending/success write order", async () => {
    const repo = createDrizzleIngestRepository();
    for (const successFirst of [false, true]) {
      const canonicalUrl = `https://example.com/analysis-merge-${randomUUID()}`;
      const suffix = randomUUID();
      const pending = {
        platform: "web_search" as const,
        sourceProvider: "web_brave",
        upstreamId: `pending-${suffix}`,
        canonicalUrl,
        title: "Canonical analysis document",
        bodyText: "short provider snippet",
        contentHash: `pending-${suffix}`,
        contentType: "opinion",
        topicTags: ["AI"],
        informationValueScore: 45,
        analysisStatus: "pending",
        imageUrls: [],
        publishedAt: new Date(),
      };
      const success = {
        ...pending,
        sourceProvider: "trendradar",
        upstreamId: `success-${suffix}`,
        bodyText: "A complete canonical document with substantially more verified detail.",
        contentHash: `success-${suffix}`,
        aiSummary: "模型完成后的可靠摘要",
        translatedTitle: "模型生成的中文标题",
        contentType: "product_update",
        topicTags: ["AI", "Agent"],
        informationValueScore: 93,
        analysisStatus: "success",
        analysisProvider: "openai_compatible",
        analysisModel: "test-model",
        analysisVersion: "v2",
        analysisAttempts: 1,
        analyzedAt: new Date(),
        analysisInputHash: documentContentHash({ title: pending.title, bodyText: "A complete canonical document with substantially more verified detail." }),
      };
      success.contentHash = success.analysisInputHash;

      const ordered = successFirst ? [success, pending] : [pending, success];
      await repo.upsertItems([ordered[0]]);
      await repo.upsertItems([ordered[1]]);

      const [stored] = await db.select().from(items).where(eq(items.canonicalUrl, canonicalUrl));
      cleanupIds.items.push(stored.id);
      expect(stored).toMatchObject({
        aiSummary: "模型完成后的可靠摘要",
        translatedTitle: "模型生成的中文标题",
        informationValueScore: 93,
        analysisStatus: "success",
        analysisProvider: "openai_compatible",
        analysisModel: "test-model",
        analysisVersion: "v2",
      });
    }
  });

  it("does not let a later low-quality observation erase canonical content", async () => {
    const repo = createDrizzleIngestRepository();
    const canonicalUrl = `https://example.com/content-quality-${randomUUID()}`;
    const full = {
      platform: "wechat" as const,
      sourceProvider: "werss",
      upstreamId: `full-${randomUUID()}`,
      canonicalUrl,
      authorName: "完整作者",
      title: "完整文章标题",
      bodyText: "这是一段完整正文，包含背景、事实、过程和最终结论。",
      contentHtml: "<article><p>完整正文第一段</p><p>完整正文第二段</p></article>",
      contentProvider: "werss",
      contentFetchStatus: "success",
      imageUrls: ["https://example.com/cover.jpg"],
      contentHash: randomUUID(),
      topicTags: ["AI"],
      analysisStatus: "success",
      aiSummary: "已有模型摘要",
      informationValueScore: 88,
      analysisVersion: "v2",
      publishedAt: new Date(),
    };
    await repo.upsertItems([full]);
    await repo.upsertItems([{
      ...full,
      sourceProvider: "web_brave",
      upstreamId: `snippet-${randomUUID()}`,
      authorName: null,
      title: null,
      bodyText: "短摘要",
      contentHtml: "<p>短摘要</p>",
      contentProvider: "direct",
      contentFetchStatus: "partial",
      imageUrls: [],
      contentHash: randomUUID(),
      analysisStatus: "pending",
      aiSummary: null,
      informationValueScore: 45,
      analysisVersion: null,
    }]);

    const [stored] = await db.select().from(items).where(eq(items.canonicalUrl, canonicalUrl));
    cleanupIds.items.push(stored.id);
    expect(stored).toMatchObject({
      authorName: "完整作者",
      title: "完整文章标题",
      bodyText: full.bodyText,
      contentHtml: full.contentHtml,
      contentProvider: "werss",
      contentFetchStatus: "success",
      imageUrls: ["https://example.com/cover.jpg"],
      aiSummary: "已有模型摘要",
      informationValueScore: 88,
      analysisStatus: "success",
    });
  });
});

describeDatabase("document analysis claim lifecycle", () => {
  it("allows an expired claim to be fenced and taken over", async () => {
    const repo = createDrizzleIngestRepository();
    const canonicalUrlHash = `claim-${randomUUID()}`;
    const analysisVersion = "claim-lifecycle-v1";
    const claimInput = {
      canonicalUrlHash,
      analysisVersion,
      leaseMinutes: 5,
    };

    try {
      const first = await repo.claimDocumentAnalysis?.({
        ...claimInput,
        ownerWorkerId: "worker-a",
      });
      expect(first).toBeTruthy();

      const blocked = await repo.claimDocumentAnalysis?.({
        ...claimInput,
        ownerWorkerId: "worker-b",
      });
      expect(blocked).toBeNull();

      await db.update(documentAnalysisClaims)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(documentAnalysisClaims.id, first!.id));

      const takeover = await repo.claimDocumentAnalysis?.({
        ...claimInput,
        ownerWorkerId: "worker-b",
      });
      expect(takeover).toBeTruthy();
      expect(takeover?.claimToken).not.toBe(first?.claimToken);

      await expect(repo.completeDocumentAnalyses?.([first!]))
        .rejects.toThrow("DOCUMENT_ANALYSIS_CLAIM_LOST");
      await expect(repo.completeDocumentAnalyses?.([takeover!]))
        .resolves.toBe(1);
    } finally {
      await db.delete(documentAnalysisClaims).where(and(
        eq(documentAnalysisClaims.canonicalUrlHash, canonicalUrlHash),
        eq(documentAnalysisClaims.analysisVersion, analysisVersion),
      ));
    }
  });
});

describeDatabase("monitor match observation persistence", () => {
  it("writes one idempotent observation per run and rejects cross-document evidence", async () => {
    const [connector] = await db.insert(connectors).values({
      platform: "web_search",
      provider: "brave",
      name: `observation-${randomUUID()}`,
    }).returning({ id: connectors.id });
    cleanupIds.connectors.push(connector.id);
    const [monitor] = await db.insert(monitors).values({
      platform: "web_search",
      connectorId: connector.id,
      name: `observation-monitor-${randomUUID()}`,
      config: { query: "observation" },
      nextRunAt: new Date(),
    }).returning({ id: monitors.id });
    cleanupIds.monitors.push(monitor.id);

    const makeRun = async () => {
      const id = randomUUID();
      await db.insert(collectionRuns).values({
        id,
        monitorId: monitor.id,
        scheduledFor: new Date(),
        idempotencyKey: `observation-run-${id}`,
        attemptToken: randomUUID(),
      });
      return id;
    };
    const firstRunId = await makeRun();
    const canonicalUrl = `https://example.com/observation-${randomUUID()}`;
    const normalized: NormalizedItem = {
      platform: "web_search",
      sourceProvider: "web_brave",
      upstreamId: `source-${randomUUID()}`,
      canonicalUrl,
      title: "Observation document",
      text: "A document used to verify durable discovery evidence.",
      imageUrls: [],
      publishedAt: new Date(),
      raw: { provider: "brave", rank: 1 },
    };
    const repository = createDrizzleIngestRepository();
    const ingestInput = {
      monitorId: monitor.id,
      runId: firstRunId,
      matchedQuery: "observation query",
      items: [normalized],
    };
    await ingest(repository, ingestInput);
    await ingest(repository, ingestInput);

    const [document] = await db.select({ id: items.id }).from(items)
      .where(eq(items.canonicalUrl, canonicalUrl));
    cleanupIds.items.push(document.id);
    let observations = await db.select().from(monitorMatchObservations)
      .where(eq(monitorMatchObservations.matchItemId, document.id));
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      matchMonitorId: monitor.id,
      collectionRunId: firstRunId,
      matchedQuery: "observation query",
      rawPayload: { provider: "brave", rank: 1 },
    });

    const secondRunId = await makeRun();
    await ingest(repository, { ...ingestInput, runId: secondRunId });
    observations = await db.select().from(monitorMatchObservations)
      .where(eq(monitorMatchObservations.matchItemId, document.id));
    expect(observations).toHaveLength(2);

    const [otherDocument] = await db.insert(items).values({
      platform: "web_search",
      upstreamId: `other-${randomUUID()}`,
      canonicalUrl: `https://example.com/other-${randomUUID()}`,
      bodyText: "Other document",
      contentHash: randomUUID(),
      publishedAt: new Date(),
    }).returning({ id: items.id });
    cleanupIds.items.push(otherDocument.id);
    const [otherSource] = await db.insert(sourceItems).values({
      itemId: otherDocument.id,
      platform: "web_search",
      sourceProvider: "brave",
      upstreamId: `other-source-${randomUUID()}`,
      sourceUrl: `https://example.com/other-source-${randomUUID()}`,
    }).returning({ id: sourceItems.id });

    await expect(db.insert(monitorMatchObservations).values({
      observationKey: randomUUID(),
      matchItemId: document.id,
      matchMonitorId: monitor.id,
      sourceItemId: otherSource.id,
      collectionRunId: secondRunId,
      rawPayload: {},
    })).rejects.toThrow();
  });
});
