import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import {
  connectors,
  itemMatches,
  items,
  monitors,
  rateLimitSlots,
  sourceItems,
  usageReservations,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import { getItems } from "@/db/queries";
import { createDrizzleIngestRepository, ingest } from "@/ingestion/ingest-items";
import { waitForDistributedRateLimit } from "@/lib/distributed-rate-limit";
import {
  releaseUsageReservation,
  reserveUsageBudget,
  type UsageBudgetReservation,
} from "@/lib/usage-budget";

const describeDatabase = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const cleanupRateKeys: string[] = [];
const cleanupConnectorIds: string[] = [];
const cleanupItemIds: string[] = [];

afterEach(async () => {
  for (const key of cleanupRateKeys.splice(0)) {
    await db.delete(rateLimitSlots).where(eq(rateLimitSlots.key, key));
  }
  for (const connectorId of cleanupConnectorIds.splice(0)) {
    await db.delete(usageReservations).where(eq(usageReservations.connectorId, connectorId));
    await db.delete(monitors).where(eq(monitors.connectorId, connectorId));
    await db.delete(connectors).where(eq(connectors.id, connectorId));
  }
  for (const itemId of cleanupItemIds.splice(0)) {
    await db.delete(items).where(eq(items.id, itemId));
  }
  delete process.env.SUMMARY_RATE_LIMIT_BACKEND;
});

describeDatabase("distributed request coordination", () => {
  it("serializes model request slots across concurrent callers", async () => {
    process.env.SUMMARY_RATE_LIMIT_BACKEND = "database";
    const key = `test-summary:${randomUUID()}`;
    cleanupRateKeys.push(key);
    const startedAt = Date.now();

    await Promise.all([
      waitForDistributedRateLimit(key, 40),
      waitForDistributedRateLimit(key, 40),
    ]);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25);
  });

  it("allows only one concurrent reservation to consume the final budget unit", async () => {
    const connectorId = randomUUID();
    const monitorId = randomUUID();
    cleanupConnectorIds.push(connectorId);
    await db.insert(connectors).values({
      id: connectorId,
      platform: "x",
      provider: "x_grok",
      name: "integration connector",
    });
    await db.insert(monitors).values({
      id: monitorId,
      platform: "x",
      connectorId,
      name: "integration monitor",
      config: { provider: "x_grok", username: "integration" },
    });

    const base: Omit<UsageBudgetReservation, "idempotencyKey"> = {
      scopeKey: `test-daily:${connectorId}`,
      connectorId,
      monitorId,
      metric: `test_x_grok_searches_${connectorId}`,
      quantity: 1,
      estimatedCostUsd: 0,
      kind: "daily_quantity",
      limit: 1,
      exhaustedError: "TEST_BUDGET_EXHAUSTED",
    };
    const first = { ...base, idempotencyKey: `test-reservation:${randomUUID()}` };
    const second = { ...base, idempotencyKey: `test-reservation:${randomUUID()}` };

    const outcomes = await Promise.allSettled([
      reserveUsageBudget(first),
      reserveUsageBudget(second),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const winner = outcomes[0].status === "fulfilled" ? first : second;
    const loser = winner === first ? second : first;

    await releaseUsageReservation(db, winner.idempotencyKey);
    await expect(reserveUsageBudget(loser)).resolves.toBe("reserved");
  });

  it("keeps one document with multiple provider observations and monitor edges", async () => {
    const webConnectorId = randomUUID();
    const trendConnectorId = randomUUID();
    const webMonitorId = randomUUID();
    const trendMonitorId = randomUUID();
    cleanupConnectorIds.push(webConnectorId, trendConnectorId);
    await db.insert(connectors).values([
      { id: webConnectorId, platform: "web_search", provider: "brave", name: "web integration" },
      { id: trendConnectorId, platform: "trendradar", provider: "trendradar", name: "rss integration" },
    ]);
    await db.insert(monitors).values([
      {
        id: webMonitorId,
        platform: "web_search",
        connectorId: webConnectorId,
        name: "web monitor",
        config: { provider: "brave", query: "shared integration document" },
      },
      {
        id: trendMonitorId,
        platform: "trendradar",
        connectorId: trendConnectorId,
        name: "rss monitor",
        config: {},
      },
    ]);

    const canonicalUrl = `https://example.com/integration/${randomUUID()}`;
    const repository = createDrizzleIngestRepository();
    await ingest(repository, {
      monitorId: webMonitorId,
      matchedQuery: "shared integration document",
      items: [{
        platform: "web_search",
        sourceProvider: "web_brave",
        upstreamId: `brave-${randomUUID()}`,
        canonicalUrl,
        title: "Shared integration document",
        text: "A document observed from web search and RSS.",
        imageUrls: [],
        publishedAt: new Date(),
        raw: { provider: "brave" },
      }],
    });
    const [document] = await db.select({ id: items.id }).from(items).where(eq(items.canonicalUrl, canonicalUrl));
    expect(document).toBeTruthy();
    cleanupItemIds.push(document.id);

    await ingest(repository, {
      monitorId: trendMonitorId,
      matchedQuery: "rss monitor",
      items: [{
        platform: "trendradar",
        sourceProvider: "trendradar",
        upstreamId: `rss-${randomUUID()}`,
        canonicalUrl,
        title: "Shared integration document",
        text: "The same document observed from the RSS source.",
        imageUrls: [],
        publishedAt: new Date(),
        raw: { provider: "rss" },
      }],
    });

    const observations = await db.select().from(sourceItems).where(eq(sourceItems.itemId, document.id));
    const matches = await db.select().from(itemMatches).where(eq(itemMatches.itemId, document.id));
    expect(observations).toHaveLength(2);
    expect(matches).toHaveLength(2);
    expect(matches.every((match) => Boolean(match.sourceItemId))).toBe(true);
    expect(matches.every((match) => match.relevanceScore != null && Boolean(match.analysisStatus))).toBe(true);

    const rssRows = await getItems({ platform: "trendradar", limit: 10 });
    const rssDocument = rssRows.find((row) => row.id === document.id);
    expect(rssDocument).toMatchObject({
      platform: "trendradar",
      sourceProvider: "trendradar",
    });

    const rssMonitorRows = await getItems({
      platform: "trendradar",
      monitorId: trendMonitorId,
      limit: 10,
    });
    expect(rssMonitorRows.some((row) => row.id === document.id)).toBe(true);

    const crossedRows = await getItems({
      platform: "trendradar",
      monitorId: webMonitorId,
      limit: 10,
    });
    expect(crossedRows.some((row) => row.id === document.id)).toBe(false);
  });
});
