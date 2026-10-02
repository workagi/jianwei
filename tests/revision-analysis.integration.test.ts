import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
const route = vi.hoisted(() => vi.fn());
const enabled = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/lib/content-router", () => ({ CONTENT_ANALYSIS_VERSION: "revision-test", routeContentItems: route }));
vi.mock("@/lib/summarizer", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/summarizer")>(), isSummaryEnabled: enabled }));
import { db } from "@/db";
import { items, monitors, itemMatches, eventItems, contentEvents, documentAnalysisClaims } from "@/db/schema";
import { canonicalUrlHash } from "@/ingestion/repositories";
import { getContentPipelineStats } from "@/db/queries";
import { createDrizzleIngestRepository, prepareIngest, commitPreparedIngest } from "@/ingestion/ingest-items";
import { documentContentHash } from "@/ingestion/content-revisions";
import { backfillMissingSummaries } from "@/lib/summary-backfill";
import { refreshEventProjection } from "@/lib/event-projection";
import { runOnce, waitForContentAnalysis } from "@/worker/index";
import type { NormalizedItem } from "@/connectors/types";

const suite = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const documents: string[] = [], tasks: string[] = [], events: string[] = [];
afterEach(async () => {
  await waitForContentAnalysis();
  vi.unstubAllEnvs();
  if (tasks.length) await db.delete(monitors).where(inArray(monitors.id, tasks.splice(0)));
  if (documents.length) await db.delete(items).where(inArray(items.id, documents.splice(0)));
  if (events.length) await db.delete(contentEvents).where(inArray(contentEvents.id, events.splice(0)));
  route.mockReset();
  enabled.mockReturnValue(true);
});

async function queue(count = 1) {
  const [monitor] = await db.insert(monitors).values({ platform: "web_search", connectorId: "00000000-0000-0000-0000-000000000003", name: "稳定性验证", config: {}, nextRunAt: new Date(Date.now() + 86400000) }).returning();
  tasks.push(monitor.id);
  const inputs: NormalizedItem[] = Array.from({ length: count }, () => ({ platform: "web_search", sourceProvider: "web_brave", upstreamId: randomUUID(), canonicalUrl: `https://example.test/${randomUUID()}`,
    title: "Acme Agent 2.0 正式开放 API", text: "公开说明给出了新的接口参数与使用条件，读者可以核对具体开放范围。", imageUrls: [], publishedAt: new Date(), raw: {} }));
  const prepared = await prepareIngest(createDrizzleIngestRepository(), { items: inputs, monitorId: monitor.id, deferAnalysis: true });
  await db.transaction(tx => commitPreparedIngest(createDrizzleIngestRepository(tx), prepared));
  const rows = await db.select().from(items).where(inArray(items.canonicalUrl, inputs.map(input => input.canonicalUrl)));
  documents.push(...rows.map(row => row.id));
  return rows;
}
function successful(inputs: NormalizedItem[]) {
  return { outcomes: new Map(inputs.map(item => [`${item.platform}|${item.upstreamId}`, {
    status: "success", summary: "Acme Agent 2.0 开放新接口，原文包含使用条件与具体参数。", contentType: "product_update", topicTags: ["Agent"],
    relevanceScore: 90, retentionSource: "model", retentionReason: "接口能力与使用条件变化", version: "revision-test", attempts: 1, processedAt: new Date(),
  }])), stats: { status: "success", attempted: inputs.length, succeeded: inputs.length, failed: 0 } };
}
suite("analysis result is fenced by its source revision", () => {
  it("shows queued originals when the model is disabled and resumes them without changing event identity", async () => {
    const [saved] = await queue();
    enabled.mockReturnValue(false);
    await runOnce(); await waitForContentAnalysis();
    const [membership] = await db.select().from(eventItems).where(eq(eventItems.itemId, saved.id));
    if (membership) events.push(membership.eventId);
    expect(membership).toBeDefined();
    expect(route).not.toHaveBeenCalled();
    expect((await db.select().from(items).where(eq(items.id, saved.id)))[0]).toMatchObject({ analysisStatus: "pending", analysisAttempts: 0 });
    enabled.mockReturnValue(true); route.mockImplementation(successful);
    await runOnce(); await waitForContentAnalysis();
    expect(route).toHaveBeenCalledTimes(1);
    expect((await db.select().from(eventItems).where(eq(eventItems.itemId, saved.id)))[0].eventId).toBe(membership.eventId);
    expect((await backfillMissingSummaries(5, { scope: "automatic" })).processed).toBe(0);
  });
  it("keeps polling while a slow analysis runs, starts only one batch and drains a burst", async () => {
    await queue(12);
    let finish!: () => void, sent!: () => void;
    const release = new Promise<void>(resolve => { finish = resolve; });
    const started = new Promise<void>(resolve => { sent = resolve; });
    route.mockImplementation(async (inputs: NormalizedItem[]) => { sent(); await release; return successful(inputs); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      expect(await Promise.race([runOnce(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("analysis blocked collection polling")), 1500); })])).toBe(0);
      await started;
      expect(await runOnce()).toBe(0);
      expect(route).toHaveBeenCalledTimes(1);
      await queue(3);
    } finally { clearTimeout(timer); finish(); await waitForContentAnalysis(); }
    route.mockImplementation(successful);
    for (let i = 0; i < 2; i++) { await runOnce(); await waitForContentAnalysis(); }
    const rows = await db.select().from(items).where(inArray(items.id, documents));
    const memberships = await db.select().from(eventItems).where(inArray(eventItems.itemId, documents));
    events.push(...new Set(memberships.map(row => row.eventId)));
    expect(rows).toHaveLength(15);
    expect(rows.every(row => row.analysisStatus === "success" && row.analysisAttempts === 1)).toBe(true);
    expect(route.mock.calls.map(call => call[0].length)).toEqual([5, 5, 5]);
  });
  it("leaves originals resumable and releases claims when shutdown interrupts analysis", async () => {
    const [saved] = await queue();
    const controller = new AbortController();
    let sent!: () => void;
    const started = new Promise<void>(resolve => { sent = resolve; });
    route.mockImplementation((_inputs: NormalizedItem[], signal: AbortSignal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }); sent();
    }));
    const processing = backfillMissingSummaries(1, { scope: "automatic", signal: controller.signal });
    const interrupted = expect(processing).rejects.toThrow("test shutdown");
    await started; controller.abort(new Error("test shutdown")); await interrupted;
    expect((await db.select().from(items).where(eq(items.id, saved.id)))[0]).toMatchObject({ analysisStatus: "pending", analysisAttempts: 0, bodyText: saved.bodyText });
    route.mockImplementation(successful);
    expect((await backfillMissingSummaries(1, { scope: "automatic" })).updated).toBe(1);
  });
  it("skips leased work so a crashed or second worker cannot strand later originals", async () => {
    const busy = await queue(8), owner = randomUUID();
    const repo = createDrizzleIngestRepository();
    try {
      for (const row of busy) await repo.claimDocumentAnalysis!({ canonicalUrlHash: canonicalUrlHash(row.canonicalUrl),
        analysisVersion: `revision-test:backfill:${row.contentRevision}:${row.contentHash}`, ownerWorkerId: owner, leaseMinutes: 30 });
      const [available] = await queue();
      route.mockImplementation(successful);
      expect((await backfillMissingSummaries(1, { scope: "automatic" })).updated).toBe(1);
      expect(route.mock.calls[0][0][0].canonicalUrl).toBe(available.canonicalUrl);
      expect((await db.select().from(items).where(inArray(items.id, busy.map(row => row.id)))).every(row => row.analysisStatus === "pending")).toBe(true);
    } finally { await db.delete(documentAnalysisClaims).where(eq(documentAnalysisClaims.ownerWorkerId, owner)); }
  });
  it("commits newly collected source input before analysis and resumes it without another collection", async () => {
    const [monitor] = await db.insert(monitors).values({ platform: "web_search", connectorId: "00000000-0000-0000-0000-000000000003", name: "原稿先落库验证", config: {} }).returning();
    tasks.push(monitor.id);
    const input: NormalizedItem = { platform: "web_search", sourceProvider: "web_brave", upstreamId: randomUUID(), canonicalUrl: `https://example.test/${randomUUID()}`,
      title: "Acme Agent 2.0 正式开放 API", text: "公开说明给出了新的接口参数与使用条件，读者可以核对具体开放范围。", imageUrls: [], publishedAt: new Date(), raw: {} };
    const prepared = await prepareIngest(createDrizzleIngestRepository(), { items: [input], monitorId: monitor.id, deferAnalysis: true });
    expect(route).not.toHaveBeenCalled();
    await db.transaction(tx => commitPreparedIngest(createDrizzleIngestRepository(tx), prepared));
    const [saved] = await db.select().from(items).where(eq(items.canonicalUrl, input.canonicalUrl));
    documents.push(saved.id);
    expect(saved).toMatchObject({ bodyText: input.text, analysisStatus: "pending", contentRevision: 1, analysisVersion: "revision-test", aiSummary: null });
    await refreshEventProjection();
    expect(await db.select().from(eventItems).where(eq(eventItems.itemId, saved.id))).toHaveLength(0);
    expect((await getContentPipelineStats()).platforms.find(row => row.platform === "web_search")?.projectionPending).toBe(0);
    // A code upgrade must not strand already accepted work from the previous version.
    await db.update(items).set({ analysisVersion: "previous-analysis-version" }).where(eq(items.id, saved.id));
    route.mockImplementation(async (inputs: NormalizedItem[]) => ({
      outcomes: new Map(inputs.map(item => [`${item.platform}|${item.upstreamId}`, {
        status: "success", summary: "Acme Agent 2.0 开放新接口，原文包含使用条件与具体参数。", contentType: "product_update", topicTags: ["Agent"],
        relevanceScore: 90, retentionSource: "model", retentionReason: "接口能力与使用条件变化", version: "revision-test", attempts: 1, processedAt: new Date(),
      }])), stats: { status: "success", attempted: inputs.length, succeeded: inputs.length, failed: 0 },
    }));
    expect((await backfillMissingSummaries(5, { scope: "automatic" })).updated).toBe(1);
    expect(route.mock.calls[0][0][0].text).toBe(input.text);
    await refreshEventProjection();
    const memberships = await db.select().from(eventItems).where(eq(eventItems.itemId, saved.id));
    events.push(...memberships.map(row => row.eventId));
    expect(memberships).toHaveLength(1);
    expect((await backfillMissingSummaries(5, { scope: "automatic" })).processed).toBe(0);
    expect(route).toHaveBeenCalledTimes(1);
  });
  it("automatically analyzes a kept source correction without polishing unrelated historical pending rows", async () => {
    const [monitor] = await db.insert(monitors).values({ platform: "web_search", connectorId: "00000000-0000-0000-0000-000000000003", name: "自动修订分析验证", config: {} }).returning();
    tasks.push(monitor.id);
    const raw = { platform: "web_search" as const, sourceProvider: "web_brave", upstreamId: randomUUID(), canonicalUrl: `https://example.test/${randomUUID()}`,
      title: "Acme Agent 2.0 开放", bodyText: "API 对所有用户免费开放。", publishedAt: new Date(), analysisStatus: "pending" };
    const repository = createDrizzleIngestRepository();
    await repository.upsertItems([{ ...raw, contentHash: documentContentHash(raw) }]);
    const historical = { ...raw, upstreamId: randomUUID(), canonicalUrl: `https://example.test/${randomUUID()}` };
    await repository.upsertItems([{ ...historical, contentHash: documentContentHash(historical) }]);
    const saved = await db.select().from(items).where(inArray(items.canonicalUrl, [raw.canonicalUrl, historical.canonicalUrl]));
    documents.push(...saved.map(row => row.id));
    await db.insert(itemMatches).values(saved.map(row => ({ itemId: row.id, monitorId: monitor.id, retentionStatus: "kept" })));
    const corrected = { ...raw, bodyText: "更正：API 仅测试用户可以使用。" };
    await repository.upsertItems([{ ...corrected, contentHash: documentContentHash(corrected) }]);
    route.mockImplementation(async (inputs: NormalizedItem[]) => ({
      outcomes: new Map(inputs.map(item => [`${item.platform}|${item.upstreamId}`, {
        status: "success", summary: "更正：Acme Agent 2.0 API 仅测试用户可以使用。", contentType: "product_update", topicTags: ["Agent"],
        relevanceScore: 90, retentionSource: "model", retentionReason: "更正接口开放范围", version: "revision-test", attempts: 1, processedAt: new Date(),
      }])), stats: { status: "success", attempted: inputs.length, succeeded: inputs.length, failed: 0 },
    }));
    expect((await backfillMissingSummaries(5, { scope: "automatic" })).updated).toBe(1);
    expect(route.mock.calls[0][0]).toHaveLength(1);
    expect(route.mock.calls[0][0][0].text).toBe(corrected.bodyText);
    const [current] = await db.select().from(items).where(eq(items.canonicalUrl, raw.canonicalUrl));
    expect(current).toMatchObject({ contentRevision: 2, analysisStatus: "success", analysisInputHash: documentContentHash(corrected) });
    expect((await backfillMissingSummaries(5, { scope: "automatic" })).processed).toBe(0);
    expect(route).toHaveBeenCalledTimes(1);
  });
  it("discards a model result when its source changes while the call is running", async () => {
    const [monitor] = await db.insert(monitors).values({ platform: "web_search", connectorId: "00000000-0000-0000-0000-000000000003", name: "分析竞争验证", config: {} }).returning();
    tasks.push(monitor.id);
    const raw = { platform: "web_search" as const, sourceProvider: "web_brave", upstreamId: randomUUID(), canonicalUrl: `https://example.test/${randomUUID()}`,
      title: "Acme Agent 2.0 正式开放 API", bodyText: "原文提供了公开接口与调用说明，用户可以查看参数和使用方式。", publishedAt: new Date("2099-01-01T00:00:00Z"), analysisStatus: "pending" };
    const input = { ...raw, contentHash: documentContentHash(raw) };
    await createDrizzleIngestRepository().upsertItems([input]);
    const [saved] = await db.select().from(items).where(eq(items.canonicalUrl, input.canonicalUrl));
    documents.push(saved.id);
    await db.insert(itemMatches).values({ itemId: saved.id, monitorId: monitor.id, retentionStatus: "kept" });
    let sent!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { sent = resolve; });
    const release = new Promise<void>(resolve => { finish = resolve; });
    route.mockImplementation(async (inputs: NormalizedItem[]) => {
      sent(); await release;
      return { outcomes: new Map(inputs.map(item => [`${item.platform}|${item.upstreamId}`, {
        status: "success", summary: "旧输入的摘要不能覆盖更正后的原文", contentType: "product_update", topicTags: ["Agent"],
        relevanceScore: 90, retentionSource: "model", retentionReason: "旧事实理由", version: "revision-test", attempts: 1, processedAt: new Date(),
      }])), stats: { status: "success", attempted: 1, succeeded: 1, failed: 0 } };
    });
    const processing = backfillMissingSummaries(1);
    await started;
    try {
      const correction = { ...input, title: "Acme Agent 2.0 更正 API 开放范围", bodyText: "更正后的接口说明：仅测试用户可以使用。" };
      await createDrizzleIngestRepository().upsertItems([{ ...correction, contentHash: documentContentHash(correction) }]);
    } finally { finish(); }
    const result = await processing;
    const [current] = await db.select().from(items).where(eq(items.id, saved.id));
    expect(result.updated).toBe(0);
    expect(current).toMatchObject({ contentRevision: 2, aiSummary: null, analysisInputHash: null, analysisStatus: "pending", title: "Acme Agent 2.0 更正 API 开放范围" });
  });
});
