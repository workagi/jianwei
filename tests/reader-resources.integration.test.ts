import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { items, monitors, sourceItems, itemMatches, monitorMatchObservations, contentEvents, eventItems, eventDevelopments, bookmarks, runtimeHealth, collectionRuns, modelAttempts, modelReceipts } from "@/db/schema";
import { getContentPipelineStats, getItems, getReaderItems } from "@/db/queries";
import { loadReaderFeed, mapRow } from "@/lib/reader-data";
import { loadContentPipelineView } from "@/lib/content-pipeline";
import { groupPersistedEvents } from "@/lib/content-clustering";
import { encodeXQuotedPost } from "@/connectors/types";
import { seedDefaultMonitors } from "@/db/seed";
import { runOnce, waitForContentAnalysis } from "@/worker/index";
import { pruneOperationalHistory } from "@/worker/maintenance";

const suite = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const documents: string[] = [], tasks: string[] = [], events: string[] = [], receipts: string[] = [];
afterEach(async () => {
  await waitForContentAnalysis();
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  if (tasks.length) await db.delete(monitors).where(inArray(monitors.id, tasks.splice(0)));
  if (documents.length) await db.delete(items).where(inArray(items.id, documents.splice(0)));
  if (events.length) await db.delete(contentEvents).where(inArray(contentEvents.id, events.splice(0)));
  if (receipts.length) {
    await db.delete(modelAttempts).where(inArray(modelAttempts.receiptKey, receipts));
    await db.delete(modelReceipts).where(inArray(modelReceipts.key, receipts.splice(0)));
  }
});
async function task(platform: "wechat" | "x" | "web_search" = "wechat") {
  const [monitor] = await db.insert(monitors).values({ platform, connectorId: platform === "x" ? "00000000-0000-0000-0000-000000000001" : platform === "wechat" ? "00000000-0000-0000-0000-000000000002" : "00000000-0000-0000-0000-000000000003", name: "资源回归", config: {}, nextRunAt: new Date(Date.now() + 86400000) }).returning();
  tasks.push(monitor.id); return monitor;
}
async function document(monitorId: string, overrides: Partial<typeof items.$inferInsert> = {}) {
  const id = randomUUID();
  const [row] = await db.insert(items).values({ id, platform: "wechat", upstreamId: id, canonicalUrl: `https://example.test/${id}`, authorName: "资源回归",
    title: "Agent 新功能发布", bodyText: "完整正文中的详细接口说明。".repeat(2000), contentHtml: "<p>" + "正文。".repeat(5000) + "</p>",
    contentHash: id, publishedAt: new Date(), contentType: "product_update", topicTags: ["Agent"], informationValueScore: 85,
    aiSummary: "Agent 新功能发布，接口文档说明了具体参数、使用条件与开放范围。", editorialReason: "接口参数和开放条件已经变化，可以据此调整现有工作流。", ...overrides }).returning();
  documents.push(id);
  const [source] = await db.insert(sourceItems).values({ itemId: id, platform: row.platform, upstreamId: id, sourceProvider: row.platform, sourceUrl: row.canonicalUrl }).returning();
  await db.insert(itemMatches).values({ itemId: id, monitorId, sourceItemId: source.id, retentionStatus: "kept", relevanceScore: 85 });
  return row;
}

suite("reader resource contracts", () => {
  it("counts queued canonical documents separately from legacy, skipped and exhausted work", async () => {
    const web = await task("web_search"), x = await task("x");
    const observedAt = new Date(Date.now() - 3600000);
    const queued = await document(web.id, { platform: "web_search", analysisVersion: "queued-test", contentObservedAt: observedAt });
    const [secondSource] = await db.insert(sourceItems).values({ itemId: queued.id, platform: "x", sourceProvider: "x_official", upstreamId: randomUUID(), sourceUrl: queued.canonicalUrl }).returning();
    await db.insert(itemMatches).values({ itemId: queued.id, monitorId: x.id, sourceItemId: secondSource.id, retentionStatus: "kept" });
    await document(web.id, { platform: "web_search" });
    await document(web.id, { platform: "web_search", analysisStatus: "skipped", analysisVersion: "queued-test" });
    await document(web.id, { platform: "web_search", analysisAttempts: 5, analysisVersion: "queued-test" });
    const excluded = await document(web.id, { platform: "web_search", analysisVersion: "queued-test" });
    await db.update(itemMatches).set({ retentionStatus: "dropped" }).where(eq(itemMatches.itemId, excluded.id));
    await document(web.id, { platform: "web_search", analysisStatus: "success", analyzedAt: new Date() });
    vi.stubEnv("CONTENT_RETRY_MAX_ATTEMPTS", "5");
    const stats = await getContentPipelineStats();
    expect(stats.queue).toMatchObject({ pending: 1, unqueued: 4, processed24h: 1 });
    expect(new Date(stats.queue.oldestPendingAt!).getTime()).toBe(observedAt.getTime());
    expect(stats.platforms.filter(row => row.analysisPending === 1)).toHaveLength(2);
    const view = await loadContentPipelineView();
    expect(view.analysisPending).toBe(1);
    expect(view.analysisUnqueued).toBe(4);
    expect(view.analysisProcessed24h).toBe(1);
  });

  it("hydrates the chosen card and preserves preferred originals, related sources, quotes and bookmarks", async () => {
    const monitor = await task("x");
    const preferred = await document(monitor.id, { platform: "x", informationValueScore: 10, authorName: "变化原文", authorHandle: "author",
      avatarUrl: "https://example.test/avatar.png", bodyText: "原始推文包含具体开放条件与新的限制说明。", contentHtml: encodeXQuotedPost({ text: "被引用的原始证据", authorName: "引用作者" }) });
    const other = await document(monitor.id, { platform: "x", authorName: "媒体来源", informationValueScore: 95 });
    await db.update(itemMatches).set({ relevanceScore: 10 }).where(eq(itemMatches.itemId, preferred.id));
    await db.update(itemMatches).set({ relevanceScore: 95 }).where(eq(itemMatches.itemId, other.id));
    await db.insert(bookmarks).values({ itemId: preferred.id });
    const [event] = await db.insert(contentEvents).values({ title: "保留当前变化", ruleVersion: "resource-test", revision: 2, activityAt: new Date() }).returning();
    events.push(event.id);
    await db.insert(eventItems).values([preferred, other].map(row => ({ itemId: row.id, eventId: event.id, sourceRevision: 1 })));
    await db.insert(eventDevelopments).values({ eventId: event.id, developmentKey: randomUUID(), eventRevision: 2, kind: "restriction", label: "开放条件变化",
      itemId: preferred.id, sourceRevision: 1, title: preferred.title!, evidence: "新的限制说明", firstSeenAt: new Date() });
    const [full] = groupPersistedEvents((await getReaderItems({ monitorId: monitor.id, eventIds: [event.id] })).map(mapRow));
    const feed = await loadReaderFeed({ mode: "changes", monitorId: monitor.id });
    expect(feed.usingDemo).toBe(false);
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({ ...full, time: feed.items[0].time });
    expect(feed.items[0]).toMatchObject({ id: preferred.id, bookmarked: true, avatarUrl: preferred.avatarUrl, quote: { text: "被引用的原始证据" } });
    expect(feed.items[0].match).toContain("订阅账号");
    expect(feed.items[0].relatedSources?.map(source => source.source)).toEqual(["媒体来源"]);
  });

  it("does not transfer classified long articles' HTML, while preserving card semantics and full-text search", async () => {
    const monitor = await task();
    await document(monitor.id, { bodyText: "正文。".repeat(3000) + "尾部可检索证据" });
    const filter = { monitorId: monitor.id, search: "尾部可检索证据" };
    const [full] = await getItems(filter), [light] = await getReaderItems(filter);
    expect(light.bodyText.length).toBe(320);
    expect(light.contentHtml).toBeNull();
    expect(light.hasFullText).toBe(true);
    expect(mapRow(light)).toEqual(mapRow(full));
    expect(mapRow(light).statusBadge?.label).toBe("全文摘要");
  });

  it("preserves X text and quote envelopes and complete legacy rule inputs", async () => {
    const monitor = await task("x");
    const post = "原始推文的完整内容。".repeat(100);
    const handle = randomUUID(), avatarUrl = "https://example.test/x-profile.png";
    await document(monitor.id, { platform: "x", bodyText: post, authorHandle: handle, contentHtml: encodeXQuotedPost({ text: "引用原文", authorName: "作者" }) });
    await document(monitor.id, { platform: "x", authorHandle: handle, avatarUrl });
    const [x] = await getReaderItems({ monitorId: monitor.id, search: "原始推文的完整内容" });
    expect(x.bodyText).toBe(post);
    expect(mapRow(x).title).toBe(post);
    expect(mapRow(x).quote?.text).toBe("引用原文");
    expect(x.avatarUrl).toBe(avatarUrl);
    const legacy = await task();
    await document(legacy.id, { contentType: null, topicTags: [], informationValueScore: null });
    const [full] = await getItems({ monitorId: legacy.id }), [light] = await getReaderItems({ monitorId: legacy.id });
    expect(light.bodyText).toBe(full.bodyText);
    expect(light.contentHtml).toBe(full.contentHtml);
    expect(mapRow(light)).toEqual(mapRow(full));
  });

  it("pages event identities despite more than 5000 duplicate materials in the newest event", async () => {
    const monitor = await task("web_search");
    const old = await document(monitor.id, { platform: "web_search" });
    const [older, newer] = await db.insert(contentEvents).values([
      { title: "另一个事件", ruleVersion: "resource-test", revision: 1, activityAt: new Date(Date.now() - 3600000) },
      { title: "大量报道的事件", ruleVersion: "resource-test", revision: 1, activityAt: new Date() },
    ]).returning();
    events.push(older.id, newer.id);
    await db.insert(eventItems).values({ itemId: old.id, eventId: older.id, sourceRevision: 1 });
    const prefix = randomUUID();
    const inserted = await db.execute<{ id: string }>(sql`insert into items (platform, upstream_id, canonical_url, title, body_text, content_hash, published_at, content_type, topic_tags, information_value_score)
      select 'web_search', ${prefix} || n, 'https://example.test/' || ${prefix} || n, '重复报道', '完整说明的正文。', md5(n::text), now(), 'product_update', '["Agent"]'::jsonb, 80
      from generate_series(1, 5001) n returning id`);
    const ids = inserted.map(row => row.id); documents.push(...ids);
    await db.execute(sql`insert into source_items (item_id, platform, source_provider, upstream_id, source_url)
      select id, platform, 'web_brave', upstream_id, canonical_url from items where ${inArray(items.id, ids)}`);
    await db.execute(sql`insert into item_matches (item_id, monitor_id, source_item_id, retention_status)
      select item_id, ${monitor.id}::uuid, id, 'kept' from source_items where ${inArray(sourceItems.itemId, ids)}`);
    await db.execute(sql`insert into event_items (item_id, event_id, source_revision)
      select id, ${newer.id}::uuid, 1 from items where ${inArray(items.id, ids)}`);
    await db.execute(sql`analyze items`);
    await db.execute(sql`analyze source_items`);
    await db.execute(sql`analyze item_matches`);
    const feed = await loadReaderFeed({ mode: "changes", monitorId: monitor.id });
    expect(feed.usingDemo).toBe(false);
    expect(feed.items.map(item => item.eventId)).toEqual([newer.id, older.id]);
    expect(feed.total).toBe(2);
    expect(feed.totalIsExact).toBe(true);
  }, 30000);

  it("does not initialize or contact unselected collectors in a fresh core deployment", async () => {
    vi.stubEnv("COMPOSE_PROFILES", "");
    await seedDefaultMonitors();
    expect(await db.select().from(monitors)).toHaveLength(0);
    const fetch = vi.fn(() => { throw new Error("Unexpected collector call"); });
    vi.stubGlobal("fetch", fetch);
    await db.delete(runtimeHealth).where(eq(runtimeHealth.service, "werss_auth"));
    expect(await runOnce()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(await db.select().from(runtimeHealth).where(eq(runtimeHealth.service, "werss_auth"))).toHaveLength(0);
    vi.stubEnv("COMPOSE_PROFILES", "wechat,trendradar");
    await seedDefaultMonitors();
    const [monitor] = await db.select().from(monitors).where(eq(monitors.platform, "trendradar"));
    tasks.push(monitor.id);
    expect(monitor.enabled).toBe(true);
  });

  it("keeps stable event pages at equal activity times and scans past filtered event batches", async () => {
    const monitor = await task("web_search");
    const ids = Array.from({ length: 105 }, () => randomUUID()).sort().reverse();
    documents.push(...ids); events.push(...ids);
    const now = new Date();
    await db.insert(items).values(ids.map((id, index) => ({ id, platform: "web_search" as const, upstreamId: id, canonicalUrl: `https://example.test/${id}`,
      title: `独立事件 ${index}`, bodyText: "不同事件的正文材料与使用条件。", contentHash: id, publishedAt: new Date(now.getTime() + index * 1000),
      contentType: "product_update", topicTags: index < 100 ? ["OpenAI"] : ["Agent"], informationValueScore: 85 })));
    await db.insert(itemMatches).values(ids.map(id => ({ itemId: id, monitorId: monitor.id, retentionStatus: "kept", relevanceScore: 85 })));
    await db.insert(contentEvents).values(ids.map(id => ({ id, title: "独立事件", ruleVersion: "resource-test", revision: 1, activityAt: now })));
    await db.insert(eventItems).values(ids.map(id => ({ itemId: id, eventId: id, sourceRevision: 1 })));
    const first = await loadReaderFeed({ mode: "changes", monitorId: monitor.id });
    const second = await loadReaderFeed({ mode: "changes", monitorId: monitor.id, page: 2 });
    const last = await loadReaderFeed({ mode: "changes", monitorId: monitor.id, page: 3 });
    expect(first.items.map(item => item.eventId)).toEqual(ids.slice(0, 50));
    expect(second.items.map(item => item.eventId)).toEqual(ids.slice(50, 100));
    expect(last.items.map(item => item.eventId)).toEqual(ids.slice(100));
    expect(first.totalIsExact).toBe(false);
    expect(second.hasNext).toBe(true);
    expect(last.hasNext).toBe(false);
    const filtered = await loadReaderFeed({ mode: "changes", monitorId: monitor.id, topic: "Agent" });
    expect(filtered.items.map(item => item.eventId)).toEqual(ids.slice(100));
    expect(filtered.total).toBe(5);
  });

  it("prunes terminal history without losing live work, today's quota or cached paid responses", async () => {
    const monitor = await task();
    const now = new Date();
    const ago = (days: number) => new Date(now.getTime() - days * 86400000);
    const runs = await db.insert(collectionRuns).values([
      { status: "success" as const, age: 40 }, { status: "failed" as const, age: 40 },
      { status: "failed" as const, age: 100 }, { status: "running" as const, age: 100 },
    ].map(({ status, age }) => ({ monitorId: monitor.id, scheduledFor: ago(age), idempotencyKey: randomUUID(),
      startedAt: ago(age), finishedAt: status === "running" ? null : ago(age), status }))).returning();
    const key = randomUUID(), owner = randomUUID(); receipts.push(key);
    await db.insert(modelReceipts).values({ key, owner, provider: "test", model: "test", status: "received", response: "cached response" });
    const attempts = await db.insert(modelAttempts).values([
      { status: "received", age: 40 }, { status: "rejected", age: 40 },
      { status: "received", age: 0 }, { status: "sending", age: 100 },
    ].map(({ status, age }) => ({ id: randomUUID(), receiptKey: key, status, startedAt: ago(age), finishedAt: status === "sending" ? null : ago(age) }))).returning();
    vi.stubEnv("OPERATIONAL_HISTORY_DAYS", "0");
    expect(await pruneOperationalHistory(now)).toEqual({ collectionRuns: 0, modelAttempts: 0 });
    vi.stubEnv("OPERATIONAL_HISTORY_DAYS", "30"); vi.stubEnv("FAILED_HISTORY_DAYS", "90");
    expect(await pruneOperationalHistory(now)).toEqual({ collectionRuns: 2, modelAttempts: 1 });
    const remainingRuns = await db.select().from(collectionRuns).where(eq(collectionRuns.monitorId, monitor.id));
    expect(remainingRuns.map(run => run.id).sort()).toEqual([runs[1].id, runs[3].id].sort());
    const remainingAttempts = await db.select().from(modelAttempts).where(eq(modelAttempts.receiptKey, key));
    expect(remainingAttempts.map(attempt => attempt.id).sort()).toEqual(attempts.slice(1).map(attempt => attempt.id).sort());
    expect((await db.select().from(modelReceipts).where(eq(modelReceipts.key, key)))[0].response).toBe("cached response");
    vi.stubEnv("OPERATIONAL_HISTORY_DAYS", "0.5");
    await pruneOperationalHistory(now);
    expect(await db.select().from(modelAttempts).where(eq(modelAttempts.id, attempts[2].id))).toHaveLength(1);
  });

  it("drains large histories in bounded batches while keeping observation evidence", async () => {
    const monitor = await task();
    const key = randomUUID(); receipts.push(key);
    await db.insert(modelReceipts).values({ key, owner: randomUUID(), provider: "test", model: "test", status: "received", response: "cached response" });
    await db.execute(sql`insert into collection_runs (monitor_id, scheduled_for, idempotency_key, started_at, finished_at, status)
      select ${monitor.id}::uuid, now() - interval '40 days', gen_random_uuid()::text, now() - interval '40 days', now() - interval '40 days', 'success'
      from generate_series(1, 2501)`);
    await db.execute(sql`insert into model_attempts (id, receipt_key, status, started_at, finished_at)
      select gen_random_uuid(), ${key}, 'received', now() - interval '40 days', now() - interval '40 days' from generate_series(1, 2501)`);
    const saved = await document(monitor.id);
    const [run] = await db.select().from(collectionRuns).where(eq(collectionRuns.monitorId, monitor.id));
    const [observation] = await db.insert(monitorMatchObservations).values({ observationKey: randomUUID(), matchItemId: saved.id,
      matchMonitorId: monitor.id, collectionRunId: run.id, rawPayload: { evidence: "original observation" } }).returning();
    vi.stubEnv("OPERATIONAL_HISTORY_DAYS", "30"); vi.stubEnv("FAILED_HISTORY_DAYS", "90");
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await pruneOperationalHistory());
    expect(results.map(result => result.collectionRuns)).toEqual([1000, 1000, 501, 0]);
    expect(results.map(result => result.modelAttempts)).toEqual([1000, 1000, 501, 0]);
    expect((await db.select().from(modelReceipts).where(eq(modelReceipts.key, key)))[0].response).toBe("cached response");
    expect((await db.select().from(monitorMatchObservations).where(eq(monitorMatchObservations.id, observation.id)))[0])
      .toMatchObject({ collectionRunId: null, rawPayload: { evidence: "original observation" } });
  });
});
