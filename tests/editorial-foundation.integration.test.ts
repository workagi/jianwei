import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { items, monitors, itemMatches, eventItems, modelAttempts, modelReceipts } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { databaseModelReceiptStore, modelReceiptKey, requestModelJson } from "@/lib/model-receipts";
import { refreshEventProjection } from "@/lib/event-projection";
import { getItems } from "@/db/queries";
import { mapRow } from "@/lib/reader-data";

const suite = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const documentIds: string[] = [];
const monitorIds: string[] = [];
const receiptKeys: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.MODEL_DAILY_REQUEST_LIMIT;
  if (receiptKeys.length) {
    await db.delete(modelAttempts).where(inArray(modelAttempts.receiptKey, receiptKeys));
    await db.delete(modelReceipts).where(inArray(modelReceipts.key, receiptKeys.splice(0)));
  }
  if (monitorIds.length) await db.delete(monitors).where(inArray(monitors.id, monitorIds.splice(0)));
  if (documentIds.length) await db.delete(items).where(inArray(items.id, documentIds.splice(0)));
});

suite("editorial foundation on PostgreSQL", () => {
  it("persists a response before business work and reuses it across store calls", async () => {
    const input = { provider: "local-test", model: "small", endpoint: "http://local.test", body: { id: randomUUID() }, headers: {}, account: "test" };
    const key = modelReceiptKey(input.provider, input.endpoint, input.body, input.account);
    receiptKeys.push(key);
    const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } })));
    vi.stubGlobal("fetch", fetch);
    await requestModelJson(input, databaseModelReceiptStore);
    expect((await requestModelJson(input, databaseModelReceiptStore)).reused).toBe(true);
    const [attempt] = await db.select().from(modelAttempts).where(eq(modelAttempts.receiptKey, key));
    expect(attempt.inputTokens).toBe(120);
    expect(attempt.estimatedCost).toBeNull();
    expect(attempt.status).toBe("received");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("enforces a database quota before sending a request", async () => {
    process.env.MODEL_DAILY_REQUEST_LIMIT = "0";
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(requestModelJson({ provider: "local-test", model: "small", endpoint: "http://local.test", body: { id: randomUUID() }, headers: {}, account: "test" }, databaseModelReceiptStore)).rejects.toThrow("MODEL_DAILY_BUDGET_EXHAUSTED");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves monitor relevance and document editorial reasons through query and reader mapping", async () => {
    const [monitor] = await db.insert(monitors).values({ platform: "web_search", connectorId: "00000000-0000-0000-0000-000000000003", name: "editorial-test", config: {} }).returning();
    monitorIds.push(monitor.id);
    const [doc] = await db.insert(items).values({ platform: "web_search", upstreamId: randomUUID(), canonicalUrl: `https://example.test/${randomUUID()}`, title: "OpenAI 发布新的模型推理能力", bodyText: "可核对的正文内容", aiSummary: "OpenAI 发布新的推理能力，并公布了对应的模型接口和使用说明。", informationValueScore: 70, editorialReason: "OpenAI 公布新的推理模型接口，提供可核对的使用说明。", publishedAt: new Date(), contentHash: randomUUID() }).returning();
    documentIds.push(doc.id);
    await db.insert(itemMatches).values({ itemId: doc.id, monitorId: monitor.id, retentionStatus: "kept", relevanceScore: 98, retentionSource: "rules", retentionReason: "命中监控关键词" });
    const rows = await getItems({ monitorId: monitor.id });
    const reader = mapRow(rows[0]);
    expect(reader.score).toBe(98);
    expect(reader.whyKept).toContain("模型接口");
    await refreshEventProjection();
    const [first] = await db.select().from(eventItems).where(eq(eventItems.itemId, doc.id));
    expect(first.eventId).toBeTruthy();
    await db.update(eventItems).set({ manual: true }).where(eq(eventItems.itemId, doc.id));
    await refreshEventProjection();
    const [second] = await db.select().from(eventItems).where(and(eq(eventItems.itemId, doc.id), eq(eventItems.manual, true)));
    expect(second.eventId).toBe(first.eventId);
  });
});
