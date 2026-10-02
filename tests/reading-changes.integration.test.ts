import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { items, monitors, itemMatches, eventItems, contentEvents, itemRevisions, bookmarks } from "@/db/schema";
import { createDrizzleIngestRepository, toItemRows } from "@/ingestion/ingest-items";
import { EVENT_PROJECTION_BATCH_SIZE, refreshEventProjection } from "@/lib/event-projection";
import { countItems, getContentPipelineStats, getItems } from "@/db/queries";
import { mapRow, loadBookmarkedFeed, loadReaderFeed } from "@/lib/reader-data";
import { loadEventDetail, updateEventReaderState } from "@/lib/event-reader";
import { writeFetchedWechatContent } from "@/lib/wechat-content-write";
import type { NormalizedItem } from "@/connectors/types";
import type { EventSignal } from "@/lib/event-signals";

const suite = process.env.RUN_DB_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const documents: string[] = [], tasks: string[] = [], events: string[] = [];
afterEach(async () => {
  if (tasks.length) await db.delete(monitors).where(inArray(monitors.id, tasks.splice(0)));
  if (documents.length) await db.delete(items).where(inArray(items.id, documents.splice(0)));
  if (events.length) await db.delete(contentEvents).where(inArray(contentEvents.id, events.splice(0)));
});
async function task(platform: "web_search" | "wechat" = "web_search") {
  const [task] = await db.insert(monitors).values({ platform, connectorId: platform === "wechat" ? "00000000-0000-0000-0000-000000000002" : "00000000-0000-0000-0000-000000000003", name: "变化验证", config: {} }).returning();
  tasks.push(task.id); return task;
}
async function article(taskId: string, overrides: Partial<NormalizedItem> = {}, score = 80, eventSignal?: EventSignal) {
  const input: NormalizedItem = { platform: "web_search", sourceProvider: "web_brave", upstreamId: randomUUID(), canonicalUrl: `https://example.test/${randomUUID()}`,
    title: `Acme Agent 2.0 正式开放 API ${taskId}`, text: "公开说明给出了接口参数和使用条件，可以核对具体开放范围。", imageUrls: [], publishedAt: new Date(), raw: {}, ...overrides };
  const [row] = toItemRows([input]);
  await createDrizzleIngestRepository().upsertItems([{ ...row, aiSummary: "Acme Agent 2.0 正式开放 API，文档给出了接口参数和使用条件。", informationValueScore: score,
    editorialReason: "Acme Agent 2.0 开放新的 API，开发者可以核对参数与使用条件。", analysisStatus: "success", analysisInputHash: row.contentHash, eventSignal: eventSignal ?? null }]);
  const [saved] = await db.select().from(items).where(eq(items.canonicalUrl, input.canonicalUrl));
  documents.push(saved.id);
  const [source] = await createDrizzleIngestRepository().upsertSourceItems([{ itemId: saved.id, platform: input.platform,
    sourceProvider: input.sourceProvider ?? input.platform, upstreamId: input.upstreamId, sourceUrl: input.canonicalUrl,
    authorName: input.authorName, rawPayload: {}, publishedAt: input.publishedAt }]);
  await db.insert(itemMatches).values({ itemId: saved.id, monitorId: taskId, sourceItemId: source.id, retentionStatus: "kept", relevanceScore: score });
  return { input, saved };
}

suite("complete event reading loop on PostgreSQL", () => {
  it("combines monitor scopes without borrowing another platform's score or matching observation", async () => {
    const web = await task(), wechat = await task("wechat"), outside = await task();
    const personal = await article(web.id, {}, 45);
    const subscribed = await article(wechat.id, { platform: "wechat", sourceProvider: "wechat_werss" }, 85);
    await article(outside.id);
    await db.update(itemMatches).set({ relevanceScore: 95 }).where(eq(itemMatches.itemId, personal.saved.id));
    await db.update(itemMatches).set({ relevanceScore: 61 }).where(eq(itemMatches.itemId, subscribed.saved.id));
    const [wechatObservation] = await createDrizzleIngestRepository().upsertSourceItems([{ itemId: personal.saved.id, platform: "wechat", sourceProvider: "wechat_werss",
      upstreamId: randomUUID(), sourceUrl: personal.saved.canonicalUrl, rawPayload: {}, publishedAt: new Date() }]);
    await db.insert(itemMatches).values({ itemId: personal.saved.id, monitorId: wechat.id, sourceItemId: wechatObservation.id, retentionStatus: "kept", relevanceScore: 99 });
    const combined = { monitorIds: [web.id, wechat.id] };
    expect(await countItems(combined)).toBe(2);
    expect((await getItems({ ...combined, featuredOnly: true, limit: 1 }))[0]).toMatchObject({ id: personal.saved.id, relevanceScore: 99 });
    expect((await getItems({ ...combined, platform: "web_search", featuredOnly: true, limit: 1 }))[0]).toMatchObject({ id: personal.saved.id, relevanceScore: 95 });
    expect(await getItems({ monitorIds: [web.id], platform: "wechat" })).toHaveLength(0);
    expect((await loadReaderFeed({ ...combined, mode: "latest" })).items).toHaveLength(2);
  });
  it("updates old followed versioned events and projects corrections outside the publication window", async () => {
    const monitor = await task();
    const oldDate = new Date(Date.now() - 20 * 86_400_000);
    const signal: EventSignal = { subject: "Acme", action: "availability", object: "Agent", version: "2.0",
      occurredOn: oldDate.toISOString().slice(0, 10), stage: "available", evidence: "Acme Agent 2.0 正式开放。", facts: [] };
    const first = await article(monitor.id, { title: "Acme Agent 2.0 正式开放", text: signal.evidence, publishedAt: oldDate, contentFetchStatus: "success" }, 80, signal);
    await refreshEventProjection();
    const [member] = await db.select().from(eventItems).where(eq(eventItems.itemId, first.saved.id));
    events.push(member.eventId);
    const [initial] = await db.select().from(contentEvents).where(eq(contentEvents.id, member.eventId));
    expect(initial.activityAt).toEqual(oldDate);
    await updateEventReaderState(member.eventId, { followed: true, readRevision: 1 });
    expect((await loadReaderFeed({ mode: "followed", monitorId: monitor.id })).items[0]).toMatchObject({ eventId: member.eventId, readRevision: 1 });
    const next = await article(monitor.id, { title: "Acme Agent 2.0 暂停访问", text: "Acme Agent 2.0 今天暂停访问。" }, 80,
      { ...signal, stage: "restricted", occurredOn: new Date().toISOString().slice(0, 10), evidence: "Acme Agent 2.0 今天暂停访问。" });
    await refreshEventProjection();
    const [nextMember] = await db.select().from(eventItems).where(eq(eventItems.itemId, next.saved.id));
    expect(nextMember.eventId).toBe(member.eventId);
    const [correction] = toItemRows([{ ...first.input, text: "更正：API 只向测试用户开放。" }]);
    await createDrizzleIngestRepository().upsertItems([correction]);
    await refreshEventProjection();
    const [revised] = await db.select().from(eventItems).where(eq(eventItems.itemId, first.saved.id));
    expect(revised.sourceRevision).toBe(2);
    const changes = await loadReaderFeed({ mode: "changes", monitorId: monitor.id, since: new Date(Date.now() - 14 * 86_400_000), followedOnly: true });
    expect(changes.items[0]).toMatchObject({ eventId: member.eventId, eventRevision: 3 });
    await refreshEventProjection();
    expect((await loadEventDetail(member.eventId))?.revision).toBe(3);
  });

  it("does not let 2001 already-processed recent rows starve an older waiting item", async () => {
    const monitor = await task(); const first = await article(monitor.id);
    await refreshEventProjection();
    const [root] = await db.select().from(eventItems).where(eq(eventItems.itemId, first.saved.id));
    events.push(root.eventId);
    const filler = Array.from({ length: 2001 }, () => {
      const id = randomUUID(); return { id, platform: "web_search" as const, upstreamId: id, canonicalUrl: `https://example.test/${id}`,
        title: "已处理材料", bodyText: "已有材料。", contentHash: id, publishedAt: new Date(), contentObservedAt: new Date() };
    });
    documents.push(...filler.map(row => row.id));
    await db.insert(items).values(filler);
    await db.insert(itemMatches).values(filler.map(row => ({ itemId: row.id, monitorId: monitor.id, retentionStatus: "kept" })));
    await db.insert(eventItems).values(filler.map(row => ({ itemId: row.id, eventId: root.eventId, sourceRevision: 1 })));
    const waiting = await article(monitor.id, { title: "独立事件待处理材料", publishedAt: new Date(Date.now() - 2 * 86_400_000) });
    expect((await getContentPipelineStats()).platforms.find(row => row.platform === "web_search")?.projectionPending).toBe(1);
    await refreshEventProjection();
    const [assigned] = await db.select().from(eventItems).where(eq(eventItems.itemId, waiting.saved.id));
    expect(assigned).toBeDefined();
    events.push(assigned.eventId);
    expect((await getContentPipelineStats()).platforms.find(row => row.platform === "web_search")?.projectionPending).toBe(0);
    expect(await refreshEventProjection()).toBe(0);
  });

  it("drains work larger than one batch without repeating the first batch or splitting identical reports", async () => {
    const monitor = await task(); const date = new Date();
    const signal: EventSignal = { subject: "Batch", action: "release", object: "Agent", version: "2.0",
      occurredOn: date.toISOString().slice(0, 10), stage: "available", evidence: "Batch Agent 2.0 已发布。", facts: [] };
    const pending = Array.from({ length: EVENT_PROJECTION_BATCH_SIZE + 1 }, () => {
      const id = randomUUID(); return { id, platform: "web_search" as const, upstreamId: id, canonicalUrl: `https://example.test/${id}`,
        title: signal.evidence, bodyText: signal.evidence, contentHash: id, publishedAt: date, eventSignal: signal };
    });
    documents.push(...pending.map(row => row.id));
    await db.insert(items).values(pending);
    await db.insert(itemMatches).values(pending.map(row => ({ itemId: row.id, monitorId: monitor.id, retentionStatus: "kept" })));
    expect(await refreshEventProjection()).toBe(EVENT_PROJECTION_BATCH_SIZE);
    const firstBatch = await db.select().from(eventItems).where(inArray(eventItems.itemId, documents));
    events.push(...new Set(firstBatch.map(row => row.eventId)));
    expect(firstBatch).toHaveLength(EVENT_PROJECTION_BATCH_SIZE);
    expect(await refreshEventProjection()).toBe(1);
    const all = await db.select().from(eventItems).where(inArray(eventItems.itemId, documents));
    expect(new Set(all.map(row => row.eventId)).size).toBe(1);
    expect(all).toHaveLength(pending.length);
    expect((await loadEventDetail(all[0].eventId))?.revision).toBe(1);
    expect(await refreshEventProjection()).toBe(0);
  });

  it("exposes evidence in ordinary feeds and lets a reader page back through all six revisions", async () => {
    const monitor = await task(); const first = await article(monitor.id, { contentFetchStatus: "success" });
    await refreshEventProjection();
    const [member] = await db.select().from(eventItems).where(eq(eventItems.itemId, first.saved.id));
    events.push(member.eventId);
    await updateEventReaderState(member.eventId, { readRevision: 1, followed: true });
    for (let revision = 2; revision <= 6; revision++) {
      const [changed] = toItemRows([{ ...first.input, text: `原文修订第${revision}次：API 条件改为仅测试用户使用。` }]);
      await createDrizzleIngestRepository().upsertItems([changed]);
      await refreshEventProjection();
    }
    const latest = await loadEventDetail(member.eventId);
    expect(latest?.revision).toBe(6);
    expect(latest?.developments.map(d => d.revision)).toEqual([6, 5, 4]);
    expect((await loadEventDetail(member.eventId, 4))?.developments.map(d => d.revision)).toEqual([3, 2, 1]);
    for (const mode of ["latest", "archive", "followed"] as const) {
      const feed = await loadReaderFeed({ mode, monitorId: monitor.id, platform: "web_search" });
      expect(feed.items[0].developments?.map(d => d.revision)).toEqual([6, 5, 4]);
    }
    await db.update(items).set({ analysisStatus: "success", aiSummary: first.saved.aiSummary, editorialReason: first.saved.editorialReason,
      informationValueScore: 80 }).where(eq(items.id, first.saved.id));
    expect((await loadReaderFeed({ mode: "featured", monitorId: monitor.id })).items[0].developments?.map(d => d.revision)).toEqual([6, 5, 4]);
    await db.insert(bookmarks).values({ itemId: first.saved.id });
    expect((await loadBookmarkedFeed()).items.find(item => item.id === first.saved.id)?.developments?.map(d => d.revision)).toEqual([6, 5, 4]);
    await updateEventReaderState(member.eventId, { readRevision: 6 });
    expect((await loadReaderFeed({ mode: "changes", monitorId: monitor.id })).items).toHaveLength(0);
    expect((await loadReaderFeed({ mode: "followed", monitorId: monitor.id })).items).toHaveLength(1);
  });
  it("resurfaces dated reopening, but not later confirmations or late historical restrictions", async () => {
    const monitor = await task();
    const signal: EventSignal = { subject: "Acme", action: "availability", object: "Agent", version: "2.0", occurredOn: "2026-09-29",
      stage: "available", evidence: "Acme Agent 2.0 在2026-09-29开放。", facts: [] };
    const first = await article(monitor.id, { title: "Acme Agent 2.0 开放", text: signal.evidence, publishedAt: new Date("2026-09-29T09:00:00Z") }, 80, signal);
    await refreshEventProjection();
    const [membership] = await db.select().from(eventItems).where(eq(eventItems.itemId, first.saved.id));
    events.push(membership.eventId);
    await updateEventReaderState(membership.eventId, { readRevision: 1, followed: true });
    await article(monitor.id, { title: "Acme Agent 2.0 暂停访问", text: "2026-09-30暂停访问。", publishedAt: new Date("2026-09-30T09:00:00Z") }, 80,
      { ...signal, stage: "restricted", occurredOn: "2026-09-30", evidence: "2026-09-30暂停访问。" });
    await refreshEventProjection();
    expect((await loadReaderFeed({ mode: "changes", monitorId: monitor.id })).items[0]).toMatchObject({ eventId: membership.eventId, eventRevision: 2 });
    await updateEventReaderState(membership.eventId, { readRevision: 2 });
    const reopened = await article(monitor.id, { title: "Acme Agent 2.0 重新开放", text: "2026-10-01恢复访问。", publishedAt: new Date("2026-10-01T09:00:00Z") }, 80,
      { ...signal, occurredOn: "2026-10-01", evidence: "2026-10-01恢复访问。" });
    await refreshEventProjection();
    expect((await loadReaderFeed({ mode: "changes", monitorId: monitor.id, followedOnly: true })).items[0]).toMatchObject({ id: reopened.saved.id, eventId: membership.eventId, eventRevision: 3 });
    await updateEventReaderState(membership.eventId, { readRevision: 3 });
    await article(monitor.id, { title: "Acme Agent 2.0 仍可访问", text: "2026-10-02仍可访问。" }, 80,
      { ...signal, occurredOn: "2026-10-02", evidence: "2026-10-02仍可访问。" });
    await article(monitor.id, { title: "Acme Agent 2.0 早期访问故障回顾", text: "2026-09-28尚无法访问。" }, 80,
      { ...signal, stage: "restricted", occurredOn: "2026-09-28", evidence: "2026-09-28尚无法访问。" });
    await refreshEventProjection();
    expect(await getItems({ monitorId: monitor.id, changesOnly: true })).toHaveLength(0);
    const [after] = await db.select().from(contentEvents).where(eq(contentEvents.id, membership.eventId));
    expect(after.revision).toBe(3);
    await refreshEventProjection();
    expect(await getItems({ monitorId: monitor.id, changesOnly: true })).toHaveLength(0);
  });

  it("initializes a manually split event even after the old membership was fully projected and read", async () => {
    const monitor = await task(); const first = await article(monitor.id);
    await refreshEventProjection();
    const [before] = await db.select().from(eventItems).where(eq(eventItems.itemId, first.saved.id));
    events.push(before.eventId);
    await updateEventReaderState(before.eventId, { readRevision: 1 });
    await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/events.ts", "split", first.saved.id]);
    const [after] = await db.select().from(eventItems).where(eq(eventItems.itemId, first.saved.id));
    events.push(after.eventId);
    expect(after.eventId).not.toBe(before.eventId);
    expect(after.manual).toBe(true);
    expect((await loadReaderFeed({ mode: "changes", monitorId: monitor.id })).items[0]).toMatchObject({ eventId: after.eventId, eventRevision: 1 });
    await refreshEventProjection();
    const [again] = await db.select().from(eventItems).where(eq(eventItems.itemId, first.saved.id));
    expect(again.eventId).toBe(after.eventId);
  });

  it("orders task candidates by their relevance before applying the query limit", async () => {
    const monitor = await task();
    const personal = await article(monitor.id, {}, 45);
    const publicChoice = await article(monitor.id, {}, 95);
    await db.update(itemMatches).set({ relevanceScore: 95 }).where(and(eq(itemMatches.itemId, personal.saved.id), eq(itemMatches.monitorId, monitor.id)));
    await db.update(itemMatches).set({ relevanceScore: 61 }).where(and(eq(itemMatches.itemId, publicChoice.saved.id), eq(itemMatches.monitorId, monitor.id)));
    expect((await getItems({ monitorId: monitor.id, featuredOnly: true, limit: 1 }))[0].id).toBe(personal.saved.id);
    expect((await getItems({ featuredOnly: true, limit: 1 }))[0].id).toBe(publicChoice.saved.id);
  });

  it("establishes late-analysis facts silently, resurfaces new same-stage details, and ignores repeated values", async () => {
    const monitor = await task();
    const first = await article(monitor.id, { authorName: "Acme 官方", text: "Acme 发布 Agent 2.0，每月收费20美元。" });
    await refreshEventProjection();
    const [membership] = await db.select().from(eventItems).where(eq(eventItems.itemId, first.saved.id));
    events.push(membership.eventId);
    const [before] = await db.select().from(contentEvents).where(eq(contentEvents.id, membership.eventId));
    await updateEventReaderState(before.id, { readRevision: before.revision, followed: true });
    const price: EventSignal["facts"][number] = { aspect: "price", value: "USD20/month", evidence: "每月收费20美元。" };
    const signal: EventSignal = { subject: "Acme", action: "release", object: "Agent", version: "2.0", occurredOn: "2026-10-02",
      stage: "available", evidence: "Acme 发布 Agent 2.0", facts: [price] };
    await db.update(items).set({ eventSignal: signal }).where(eq(items.id, first.saved.id));
    await refreshEventProjection();
    expect(await getItems({ monitorId: monitor.id, changesOnly: true })).toHaveLength(0);

    const access: EventSignal["facts"][number] = { aspect: "access", value: "includes EU users", evidence: "现在也向欧盟用户开放。" };
    const detail = await article(monitor.id, { authorName: "Acme 官方", title: "Acme Agent 2.0 开放欧盟访问，价格不变", text: "Acme 发布 Agent 2.0，每月收费20美元。现在也向欧盟用户开放。" }, 90,
      { ...signal, facts: [price, access] });
    await refreshEventProjection();
    const changes = await loadReaderFeed({ mode: "changes", monitorId: monitor.id, followedOnly: true });
    expect(changes.items).toHaveLength(1);
    expect(changes.items[0]).toMatchObject({ id: detail.saved.id, eventId: before.id, eventRevision: before.revision + 1 });
    expect(changes.items[0].developments?.some(row => row.evidence === access.evidence)).toBe(true);
    await updateEventReaderState(before.id, { readRevision: before.revision + 1 });

    await article(monitor.id, { authorName: "Acme 官方", title: "Acme launches Agent 2.0: access in Europe", text: "Acme launches Agent 2.0. The monthly price is USD20. Access now includes EU users." }, 95,
      { ...signal, evidence: "Acme launches Agent 2.0.", facts: [{ ...access, evidence: "Access now includes EU users." }, { ...price, evidence: "The monthly price is USD20." }] });
    await refreshEventProjection();
    expect(await getItems({ monitorId: monitor.id, changesOnly: true })).toHaveLength(0);
    const [after] = await db.select().from(contentEvents).where(eq(contentEvents.id, before.id));
    expect(after.revision).toBe(before.revision + 1);

    await article(monitor.id, { authorName: "Acme 官方", title: "Acme Agent 2.0 公布新月费", text: "Acme 发布 Agent 2.0。每月收费30美元。" }, 90,
      { ...signal, facts: [{ ...price, value: "USD30/month", evidence: "每月收费30美元。" }] });
    await refreshEventProjection();
    const priceChange = await loadReaderFeed({ mode: "changes", monitorId: monitor.id });
    expect(priceChange.items[0].eventRevision).toBe(before.revision + 2);
    expect(priceChange.items[0].developments?.some(row => row.evidence === "每月收费30美元。")).toBe(true);
    await updateEventReaderState(before.id, { readRevision: before.revision + 2 });
    await article(monitor.id, { authorName: "旧材料转述", title: "Acme Agent 2.0 每月20美元的发布说明", text: first.input.text }, 80, signal);
    await refreshEventProjection();
    expect(await getItems({ monitorId: monitor.id, changesOnly: true })).toHaveLength(0);
  });

  it("does not resurface on repeated reporting or representative swaps, but does resurface after a shorter full-text correction", async () => {
    const monitor = await task();
    const first = await article(monitor.id, { platform: "wechat", sourceProvider: "wechat_werss", authorName: "原来源", contentFetchStatus: "success", contentHtml: "<p>原文说明 API 对所有用户免费开放。</p>" }, 80,
      { subject: "Acme", action: "release", object: "Agent", version: "2.0", occurredOn: null, stage: "available", evidence: "原文说明 API 对所有用户免费开放。", facts: [] });
    await refreshEventProjection();
    const [membership] = await db.select().from(eventItems).where(eq(eventItems.itemId, first.saved.id));
    events.push(membership.eventId);
    const [before] = await db.select().from(contentEvents).where(eq(contentEvents.id, membership.eventId));
    expect(await updateEventReaderState(before.id, { readRevision: before.revision, followed: true })).toBe("ok");
    expect(await getItems({ monitorId: monitor.id, changesOnly: true })).toHaveLength(0);

    const duplicate = await article(monitor.id, { authorName: "另一报道", title: first.input.title }, 95);
    await refreshEventProjection();
    const [afterCoverage] = await db.select().from(contentEvents).where(eq(contentEvents.id, before.id));
    expect(afterCoverage.revision).toBe(before.revision);
    expect(afterCoverage.activityAt).toEqual(before.activityAt);
    expect(await getItems({ monitorId: monitor.id, changesOnly: true })).toHaveLength(0);
    const cards = await loadReaderFeed({ mode: "featured", monitorId: monitor.id });
    expect(cards.items[0]).toMatchObject({ id: duplicate.saved.id, eventId: before.id, followed: true, readRevision: before.revision });

    const [revision] = toItemRows([{ ...first.input, text: "更正：收费。", contentHtml: "<p>更正：收费。</p>" }]);
    await createDrizzleIngestRepository().upsertItems([revision]);
    const [changed] = await db.select().from(items).where(eq(items.id, first.saved.id));
    expect(changed).toMatchObject({ contentRevision: 2, aiSummary: null, translatedTitle: null, eventSignal: null, analysisInputHash: null, analysisStatus: "pending", contentHtml: "<p>更正：收费。</p>" });
    expect(await db.select().from(itemRevisions).where(eq(itemRevisions.itemId, changed.id))).toHaveLength(2);
    await refreshEventProjection();
    const updates = await loadReaderFeed({ mode: "changes", monitorId: monitor.id, followedOnly: true });
    expect(updates.items).toHaveLength(1);
    expect(updates.items[0].id).toBe(first.saved.id);
    expect(updates.items[0].eventRevision).toBe(before.revision + 1);
    expect(updates.items[0].developments?.some(d => d.evidence.includes("收费"))).toBe(true);
    expect(await updateEventReaderState(before.id, { readRevision: before.revision })).toBe("ok");
    expect(await getItems({ monitorId: monitor.id, changesOnly: true })).not.toHaveLength(0);
    expect(await updateEventReaderState(before.id, { readRevision: before.revision + 2 })).toBe("invalid_revision");
  });

  it("allows a strongly relevant task result below the public document threshold", async () => {
    const monitor = await task(); const { saved } = await article(monitor.id, {}, 45);
    await db.update(itemMatches).set({ relevanceScore: 95 }).where(and(eq(itemMatches.itemId, saved.id), eq(itemMatches.monitorId, monitor.id)));
    expect((await getItems({ monitorId: monitor.id, featuredOnly: true })).map(mapRow)[0].score).toBe(95);
    expect((await getItems({ featuredOnly: true })).some(row => row.id === saved.id)).toBe(false);
  });

  it("keeps slower, older observations from rolling back a newer source revision", async () => {
    const monitor = await task(); const first = await article(monitor.id, { platform: "wechat", sourceProvider: "wechat_werss", contentFetchStatus: "success", contentHtml: "<p>第一版较长正文。</p>" });
    const [old] = toItemRows([{ ...first.input, contentHtml: "<p>旧请求返回的正文。</p>" }]);
    old.contentObservedAt = new Date(0);
    const [newer] = toItemRows([{ ...first.input, contentHtml: "<p>更正。</p>" }]);
    await createDrizzleIngestRepository().upsertItems([newer]);
    await createDrizzleIngestRepository().upsertItems([old]);
    const [saved] = await db.select().from(items).where(eq(items.id, first.saved.id));
    expect(saved.contentHtml).toBe("<p>更正。</p>");
    expect(saved.contentRevision).toBe(2);
    expect(await writeFetchedWechatContent(saved.id, first.saved, { html: "<p>过期补抓</p>", status: "success" })).toBeNull();
  });
});
