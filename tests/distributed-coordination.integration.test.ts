import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import {
  connectors,
  monitors,
  rateLimitSlots,
  usageReservations,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import { waitForDistributedRateLimit } from "@/lib/distributed-rate-limit";
import {
  releaseUsageReservation,
  reserveUsageBudget,
  type UsageBudgetReservation,
} from "@/lib/usage-budget";

const describeDatabase = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const cleanupRateKeys: string[] = [];
const cleanupConnectorIds: string[] = [];

afterEach(async () => {
  for (const key of cleanupRateKeys.splice(0)) {
    await db.delete(rateLimitSlots).where(eq(rateLimitSlots.key, key));
  }
  for (const connectorId of cleanupConnectorIds.splice(0)) {
    await db.delete(usageReservations).where(eq(usageReservations.connectorId, connectorId));
    await db.delete(monitors).where(eq(monitors.connectorId, connectorId));
    await db.delete(connectors).where(eq(connectors.id, connectorId));
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
});
