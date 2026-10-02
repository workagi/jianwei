import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db, sql as client } from "../../../src/db";
import { contentEvents, eventDevelopments, eventItems, itemMatches, items, monitors } from "../../../src/db/schema";
import { createDrizzleIngestRepository, toItemRows } from "../../../src/ingestion/ingest-items";
import { parseEventSignal, type EventSignal } from "../../../src/lib/event-signals";
import { deriveMonitorRetention } from "../../../src/lib/content-retention";
import { refreshEventProjection } from "../../../src/lib/event-projection";
import { updateEventReaderState } from "../../../src/lib/event-reader";
import { loadReaderFeed } from "../../../src/lib/reader-data";
import { backfillMissingSummaries } from "../../../src/lib/summary-backfill";
import type { NormalizedItem } from "../../../src/connectors/types";

// Run only against a disposable, migrated and seeded review database.
// No provider calls: fail immediately if a code path attempts an external fetch.
let fetchAttempts = 0;
globalThis.fetch = async () => { fetchAttempts += 1; throw new Error("External fetch disabled in review probe"); };
const results: Record<string, unknown> = {};
const now = new Date();
const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
const repo = createDrizzleIngestRepository();

async function task(name: string) {
  const [row] = await db.insert(monitors).values({ platform: "web_search", connectorId: "00000000-0000-0000-0000-000000000003", name, config: {} }).returning();
  return row;
}
async function article(taskId: string, overrides: Partial<NormalizedItem> = {}, signal?: EventSignal) {
  const input: NormalizedItem = { platform: "web_search", sourceProvider: "web_brave", upstreamId: randomUUID(),
    canonicalUrl: `https://example.test/review/${randomUUID()}`, authorName: "Acme 官方",
    title: `Acme Agent 2.0 正式开放 API ${taskId}`, text: "接口已向用户开放，文档给出了具体参数和访问条件。",
    imageUrls: [], publishedAt: now, raw: {}, ...overrides };
  const [row] = toItemRows([input]);
  await repo.upsertItems([{ ...row, aiSummary: "接口正式开放，文档给出了 API 的具体参数与访问条件，开发者可以据此检查集成。",
    informationValueScore: 80, editorialReason: "公开接口参数和访问条件发生变化，可据此检查现有集成是否需要调整。",
    analysisStatus: "success", analysisInputHash: row.contentHash, eventSignal: signal ?? null }]);
  const [saved] = await db.select().from(items).where(eq(items.canonicalUrl, input.canonicalUrl));
  const [source] = await repo.upsertSourceItems([{ itemId: saved.id, platform: input.platform, sourceProvider: input.sourceProvider!,
    upstreamId: input.upstreamId, sourceUrl: input.canonicalUrl, authorName: input.authorName, rawPayload: {}, publishedAt: input.publishedAt }]);
  await db.insert(itemMatches).values({ itemId: saved.id, monitorId: taskId, sourceItemId: source.id, retentionStatus: "kept", relevanceScore: 80 });
  return { input, saved };
}
async function membership(itemId: string) {
  const [row] = await db.select().from(eventItems).where(eq(eventItems.itemId, itemId));
  return row;
}

async function main() {
  const signal: EventSignal = { subject: "Acme", action: "release", object: "Agent", version: "2.0", occurredOn: null,
    stage: "available", evidence: "Acme Agent 2.0 is not available yet.", facts: [{ aspect: "price", value: "USD0/month", evidence: "The monthly price is USD30." }] };
  const accepted = parseEventSignal(signal, `${signal.evidence} The monthly price is USD30.`);
  results.quoteWithoutEntailment = { accepted: Boolean(accepted), stage: accepted?.stage, price: accepted?.facts[0]?.value,
    original: "Acme Agent 2.0 is not available yet. The monthly price is USD30." };
  results.taskScoreWithoutKeyword = deriveMonitorRetention({ keywords: ["MCP"], contentTypeFilters: ["tutorial"] },
    { contentType: "industry", topicTags: [], informationValueScore: 85, title: "无关公司融资公告", bodyText: "某企业完成新一轮融资。" });

  const correctionTask = await task("修订自动接管缺口");
  const first = await article(correctionTask.id, { contentHtml: "<p>接口免费向全部用户开放，旧文给出了详细使用说明。</p>", contentFetchStatus: "success" });
  await refreshEventProjection(now);
  const correctionEvent = await membership(first.saved.id);
  await updateEventReaderState(correctionEvent.eventId, { readRevision: 1, followed: true });
  const [revised] = toItemRows([{ ...first.input, text: "更正：只对付费用户开放。", contentHtml: "<p>更正：只对付费用户开放。</p>" }]);
  await repo.upsertItems([revised]);
  const [afterRevision] = await db.select().from(items).where(eq(items.id, first.saved.id));
  process.env.SUMMARY_PROVIDER = "openai_compatible";
  process.env.SUMMARY_BASE_URL = "https://example.test/v1";
  process.env.SUMMARY_API_KEY = "review-placeholder";
  process.env.SUMMARY_MODEL = "review-placeholder";
  const retry = await backfillMissingSummaries(5, { scope: "failures" });
  await refreshEventProjection(now);
  const correctedFeed = await loadReaderFeed({ mode: "featured", monitorId: correctionTask.id });
  results.pendingCorrection = { contentRevision: afterRevision.contentRevision, analysisStatus: afterRevision.analysisStatus,
    aiSummary: afterRevision.aiSummary, automaticRetryCandidates: retry.candidates, featuredCards: correctedFeed.items.length };

  const longTask = await task("长期关注身份");
  const rootDate = ago(20);
  const availability: EventSignal = { ...signal, action: "availability", evidence: "Acme Agent 2.0 正式开放。", facts: [], occurredOn: rootDate.toISOString().slice(0, 10) };
  const root = await article(longTask.id, { publishedAt: rootDate }, availability);
  await db.update(items).set({ createdAt: rootDate, contentObservedAt: rootDate }).where(eq(items.id, root.saved.id));
  await refreshEventProjection(new Date(rootDate.getTime() + 3600_000));
  const oldMembership = await membership(root.saved.id);
  await updateEventReaderState(oldMembership.eventId, { readRevision: 1, followed: true });
  const next = await article(longTask.id, { title: `Acme Agent 2.0 暂停访问 ${longTask.id}`, text: "Acme Agent 2.0 今日暂停访问。" },
    { ...availability, stage: "restricted", occurredOn: now.toISOString().slice(0, 10), evidence: "Acme Agent 2.0 今日暂停访问。" });
  await refreshEventProjection(now);
  const newMembership = await membership(next.saved.id);
  results.followAfterWindow = { sameEvent: oldMembership.eventId === newMembership.eventId,
    followedCards: (await loadReaderFeed({ mode: "changes", monitorId: longTask.id, followedOnly: true, since: ago(14) })).items.length,
    unfilteredCards: (await loadReaderFeed({ mode: "changes", monitorId: longTask.id, since: ago(14) })).items.length };

  const [oldRevision] = toItemRows([{ ...root.input, text: "更正：从未免费开放。", contentHtml: "<p>更正：从未免费开放。</p>", contentFetchStatus: "success" }]);
  await repo.upsertItems([oldRevision]);
  await refreshEventProjection(now);
  const afterOldMembership = await membership(root.saved.id);
  const [oldItem] = await db.select().from(items).where(eq(items.id, root.saved.id));
  const [oldEvent] = await db.select().from(contentEvents).where(eq(contentEvents.id, oldMembership.eventId));
  results.oldArticleCorrection = { contentRevision: oldItem.contentRevision, projectedRevision: afterOldMembership.sourceRevision, eventRevision: oldEvent.revision };

  const delayedTask = await task("多次未读进展");
  const seed = await article(delayedTask.id);
  await refreshEventProjection(now);
  const delayed = await membership(seed.saved.id);
  await updateEventReaderState(delayed.eventId, { readRevision: 1, followed: true });
  await db.update(contentEvents).set({ revision: 6, latestChange: "第6版变化", activityAt: now }).where(eq(contentEvents.id, delayed.eventId));
  await db.insert(eventDevelopments).values([2, 3, 4, 5, 6].map(revision => ({ eventId: delayed.eventId, eventRevision: revision,
    developmentKey: `review:${revision}`, kind: "fact", label: `第${revision}版变化`, title: `第${revision}版`, evidence: `第${revision}版的原文信息。`,
    itemId: seed.saved.id, sourceRevision: 1, firstSeenAt: now })));
  const beforeRead = await loadReaderFeed({ mode: "changes", monitorId: delayedTask.id });
  const card = beforeRead.items[0];
  await updateEventReaderState(delayed.eventId, { readRevision: card.eventRevision });
  results.readBeyondVisible = { readBefore: card.readRevision, eventRevision: card.eventRevision,
    displayedRevisions: card.developments?.map(d => d.revision), unreadAfterMark: (await loadReaderFeed({ mode: "changes", monitorId: delayedTask.id })).items.length };
  results.featuredEvidence = { eventRevision: (await loadReaderFeed({ mode: "featured", monitorId: delayedTask.id })).items[0]?.eventRevision,
    developmentRows: (await loadReaderFeed({ mode: "featured", monitorId: delayedTask.id })).items[0]?.developments?.length ?? 0 };

  const historyTask = await task("旧稿新收录");
  const historical = await article(historyTask.id, { publishedAt: ago(10), title: `旧稿首次收录 ${historyTask.id}` });
  await refreshEventProjection(now);
  const historyCard = (await loadReaderFeed({ mode: "changes", monitorId: historyTask.id, since: ago(1) })).items[0];
  results.historicalImportClock = { publishedAt: historical.input.publishedAt.toISOString(), cardDate: historyCard?.date,
    appearsInLastDayChanges: Boolean(historyCard), label: historyCard?.eventChange };

  const windowTask = await task("固定窗口无处理进度");
  const waiting = await article(windowTask.id, { publishedAt: ago(2), title: `窗口后待处理材料 ${windowTask.id}` });
  const [fillerEvent] = await db.insert(contentEvents).values({ title: "已处理窗口占位", ruleVersion: "review", revision: 1 }).returning();
  const fillerIds = Array.from({ length: 2000 }, () => randomUUID());
  await db.insert(items).values(fillerIds.map((id, index) => ({ id, platform: "web_search" as const, upstreamId: id,
    canonicalUrl: `https://example.test/window/${id}`, title: `已处理占位 ${index}`, bodyText: "已处理内容。", contentHash: id,
    publishedAt: ago(0.1), analysisStatus: "success" })));
  await db.insert(itemMatches).values(fillerIds.map(itemId => ({ itemId, monitorId: windowTask.id, retentionStatus: "kept" })));
  await db.insert(eventItems).values(fillerIds.map(itemId => ({ itemId, eventId: fillerEvent.id, sourceRevision: 1 })));
  await refreshEventProjection(now);
  const assignedFirst = Boolean(await membership(waiting.saved.id));
  await refreshEventProjection(now);
  results.fixedWindowStarvation = { newerProcessedDocuments: fillerIds.length, assignedFirstRefresh: assignedFirst,
    assignedSecondRefresh: Boolean(await membership(waiting.saved.id)) };

  results.fetchAttempts = fetchAttempts;
  results.scope = "Synthetic fixtures on disposable PostgreSQL 17; no real model, collector, production data or browser exercise.";
  await writeFile(new URL("./current-system-results.json", import.meta.url), `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => client.end({ timeout: 5 }));
