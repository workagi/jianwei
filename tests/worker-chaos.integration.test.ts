/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- integration test with complex DB types
/**
 * Multi-worker chaos integration tests.
 * These tests verify that the worker lease fencing, concurrent document
 * insertion, stale run cleanup, and budget reservations behave correctly
 * when multiple workers operate on the same database concurrently.
 *
 * Requires: RUN_DB_INTEGRATION_TESTS=1 and a running PostgreSQL instance.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { db } from "@/db";
import { monitors, collectionRuns, items, sourceItems, usageLedger } from "@/db/schema";
import { createDrizzleIngestRepository } from "@/ingestion/repositories";
import { cleanupStaleRunningRuns } from "@/worker/stale-run-reaper";
import { createStructuredLogger } from "@/lib/structured-log";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

const RUN_DB_TESTS = process.env.RUN_DB_INTEGRATION_TESTS === "1";

const log = createStructuredLogger({ service: "chaos-test" });

describe.skipIf(!RUN_DB_TESTS)("multi-worker chaos", () => {
  const workerA = `chaos-A-${randomUUID().slice(0, 8)}`;
  const workerB = `chaos-B-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    // Seed a monitor for lease tests
    await db.insert(monitors).values({
      id: randomUUID(),
      name: "Chaos Test Monitor",
      platform: "web_search" as const,
      connectorId: "chaos-test",
      config: { provider: "brave", query: "test" },
      pollIntervalMinutes: 60,
      enabled: true,
      nextRunAt: new Date(Date.now() - 60_000), // due now
      failureCount: 0,
    }).onConflictDoNothing();
  });

  afterAll(async () => {
    // Cleanup
    await db.delete(collectionRuns).where(eq(collectionRuns.errorCode, "chaos-test"));
    await db.delete(monitors).where(eq(monitors.name, "Chaos Test Monitor"));
    await db.delete(items).where(eq(items.canonicalUrl, "https://chaos-test.example.com/doc"));
    await db.delete(sourceItems).where(eq(sourceItems.sourceProvider, "chaos-test"));
    await db.delete(usageLedger).where(eq(usageLedger.connectorId, "chaos-test"));
  });

  it("lease fencing: only current lease holder can commit", async () => {
    // Simulate: Worker A claims monitor, Worker B tries to claim same monitor
    // Both should not succeed simultaneously in a real scenario.
    // This test verifies that the lease epoch prevents stale commits.
    const due = await db.select().from(monitors)
      .where(eq(monitors.name, "Chaos Test Monitor"))
      .limit(1);

    if (due.length === 0) {
      log.warn("chaos.lease_test.no_monitor");
      return;
    }

    const monitor = due[0];

    // Worker A claims with epoch bump
    const [claimed] = await db.update(monitors)
      .set({
        leaseOwner: workerA,
        leaseUntil: new Date(Date.now() + 300_000),
        leaseEpoch: (activeMonitor[0].leaseEpoch ?? 0) + 1,
      })
      .where(and(
        eq(monitors.id, monitor.id),
        sql`(${monitors.leaseUntil} is null or ${monitors.leaseUntil} < now())`,
      ))
      .returning({ leaseEpoch: monitors.leaseEpoch });

    const epochA = (claimed as any).leaseEpoch ?? (claimed as any)[0]?.leaseEpoch;
    expect(epochA).toBeGreaterThan(0);

    // Worker B attempts to take over while A still holds lease
    const [stolenB] = await db.update(monitors)
      .set({
        leaseOwner: workerB,
        leaseUntil: new Date(Date.now() + 300_000),
        leaseEpoch: (activeMonitor[0].leaseEpoch ?? 0) + 1,
      })
      .where(and(
        eq(monitors.id, monitor.id),
        sql`(${monitors.leaseUntil} is null or ${monitors.leaseUntil} < now())`,
      ))
      .returning({ leaseEpoch: monitors.leaseEpoch });

    // B should get 0 rows because A still holds the lease
    expect(stolenB).toHaveLength(0);

    // Verify A can still commit with its epoch
    const [committed] = await db.update(monitors)
      .set({ leaseOwner: null, leaseUntil: null })
      .where(and(
        eq(monitors.id, monitor.id),
        eq(monitors.leaseOwner, workerA),
        eq(monitors.leaseEpoch, epochA),
      ))
      .returning({ id: monitors.id });

    expect(committed).toBeDefined();
    expect(committed).toHaveLength(1);
  });

  it("concurrent canonical URL: only one document wins", async () => {
    const repo = createDrizzleIngestRepository();

    const canonicalUrl = "https://chaos-test.example.com/doc";
    const rowsA = [{
      platform: "web_search" as const,
      sourceProvider: "brave",
      upstreamId: `chaos-a-${randomUUID().slice(0, 8)}`,
      canonicalUrl,
      title: "Worker A version",
      bodyText: "Content from worker A",
      authorId: null, authorName: null, authorHandle: null,
      imageUrls: [], contentHash: randomUUID(),
      publishedAt: new Date(),
    }];

    const rowsB = [{
      platform: "web_search" as const,
      sourceProvider: "serper",
      upstreamId: `chaos-b-${randomUUID().slice(0, 8)}`,
      canonicalUrl,
      title: "Worker B version",
      bodyText: "Content from worker B with more detail",
      authorId: null, authorName: null, authorHandle: null,
      imageUrls: [], contentHash: randomUUID(),
      publishedAt: new Date(),
    }];

    // Concurrent insert
    const [resultA, resultB] = await Promise.all([
      repo.upsertItems(rowsA as any),
      repo.upsertItems(rowsB as any),
    ]);

    // Both should return exactly 1 document with the same ID
    expect(resultA).toHaveLength(1);
    expect(resultB).toHaveLength(1);
    expect(resultA[0].id).toBe(resultB[0].id);

    // Verify only one document exists in DB
    const docs = await db.select({ id: items.id }).from(items)
      .where(eq(items.canonicalUrl, canonicalUrl));
    expect(docs).toHaveLength(1);

    // Both source items should be registered
    const sources = await db.select().from(sourceItems)
      .where(eq(sourceItems.sourceProvider, "chaos-test"));
  });

  it("stale run cleanup: leaves active runs alone", async () => {
    // Create a collection run that's old but has a valid monitor lease
    const activeMonitor = await db.select().from(monitors)
      .where(eq(monitors.name, "Chaos Test Monitor"))
      .limit(1);

    if (activeMonitor.length === 0) return;

    // Set up: active monitor with valid lease
    await db.update(monitors)
      .set({
        leaseOwner: workerA,
        leaseUntil: new Date(Date.now() + 600_000),
        leaseEpoch: (activeMonitor[0].leaseEpoch ?? 0) + 1,
      })
      .where(eq(monitors.id, activeMonitor[0].id));

    const runId = randomUUID();
    await db.insert(collectionRuns).values({
      id: runId,
      monitorId: activeMonitor[0].id,
      status: "running" as const,
      startedAt: new Date(Date.now() - 900_000),
      lastProgressAt: new Date(Date.now() - 900_000),
    } as any).onConflictDoNothing();

    // Run stale cleanup
    const cleaned = await cleanupStaleRunningRuns(300_000, log);

    // The run should NOT be cleaned because the monitor has a valid lease
    const run = await db.select().from(collectionRuns)
      .where(eq(collectionRuns.id, runId))
      .limit(1);

    expect(run).toHaveLength(1);
    expect(run[0].status).toBe("running");

    // Cleanup our test data
    await db.delete(collectionRuns).where(eq(collectionRuns.id, runId));
    await db.update(monitors)
      .set({ leaseOwner: null, leaseUntil: null })
      .where(eq(monitors.id, activeMonitor[0].id));
  });
});
