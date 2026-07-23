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
} from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { createDrizzleIngestRepository } from "@/ingestion/ingest-items";
import type { NormalizedItem } from "@/connectors/types";

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
      rawPayload: {},
      publishedAt: new Date(),
    }];
    const stored = await repo.upsertSourceItems(observations);

    // Verify itemId is still docA (immutable binding)
    expect(stored.length).toBe(1);
    expect(stored[0].itemId).toBe(docA.id);
    expect(stored[0].itemId).not.toBe(docB.id);
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
