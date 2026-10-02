import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { contentEvents, eventItems, eventDevelopments, eventReaderStates, items } from "@/db/schema";
import { canJoinEventGroup, type ClusterableReaderItem } from "@/lib/content-clustering";
import { canJoinEventStory, developmentInputs, selectFreshDevelopments, type DevelopmentHistory } from "@/lib/event-changes";
import { htmlDocumentText } from "@/lib/document-text";
import { isSummaryEnabled } from "@/lib/summarizer";

export const EVENT_RULE_VERSION = "v7-progress-worklist";
export const EVENT_PROJECTION_BATCH_SIZE = 200;
export interface EventCandidate extends ClusterableReaderItem { eventId?: string; manual?: boolean }

/** Existing identities, including manual assignments, are never changed by automatic refresh. */
export function planEventAssignments(candidates: EventCandidate[]): Array<{ itemId: string; eventId: string; title: string }> {
  const groups = new Map<string, EventCandidate[]>();
  for (const item of candidates) {
    if (!item.eventId) continue;
    const group = groups.get(item.eventId) ?? [];
    group.push(item);
    groups.set(item.eventId, group);
  }
  const assignments: Array<{ itemId: string; eventId: string; title: string }> = [];
  for (const item of [...candidates].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))) {
    if (item.eventId) continue;
    const match = [...groups].find(([, members]) => canJoinEventGroup(members, item))
      ?? [...groups].find(([, members]) => canJoinEventStory([...members].sort((a, b) => a.date.localeCompare(b.date))[0], item));
    const eventId = match?.[0] ?? randomUUID();
    const members = groups.get(eventId) ?? [];
    members.push(item);
    groups.set(eventId, members);
    assignments.push({ itemId: item.id, eventId, title: members[0].title });
  }
  return assignments;
}

/** Bounded background work. No model calls and no dependence on a reader request. */
export async function refreshEventProjection(now = new Date()): Promise<number> {
  const waitForAnalysis = isSummaryEnabled();
  return db.transaction(async (tx) => {
    const lock = await tx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(hashtext('jianwei:event-projection')) as locked`);
    if (!lock[0]?.locked) return 0;
    // A database fingerprint is only a processing checkpoint, not an integrity guarantee.
    const fingerprint = sql<string | null>`case when ${items.eventSignal} is not null then md5(${items.eventSignal}::text) end`;
    const kept = sql`exists (select 1 from item_matches im where im.item_id = ${items.id} and im.retention_status = 'kept')`;
    const rows = await tx.select({
      id: items.id, platform: items.platform, source: items.authorName,
      title: items.title, translatedTitle: items.translatedTitle, excerpt: items.aiSummary,
      tags: items.topicTags, score: items.informationValueScore, reason: items.editorialReason,
      date: items.publishedAt, eventId: eventItems.eventId, manual: eventItems.manual,
      bodyText: items.bodyText, contentHtml: items.contentHtml, sourceRevision: items.contentRevision,
      eventSignal: items.eventSignal, fingerprint,
      followed: eventReaderStates.followed,
      projectedRevision: eventItems.sourceRevision, discoveredAt: items.createdAt, observedAt: items.contentObservedAt,
      changeKind: sql<string | null>`(select change_kind from item_revisions r where r.item_id = ${items.id} and r.revision = ${items.contentRevision})`,
    }).from(items).leftJoin(eventItems, eq(items.id, eventItems.itemId))
      .leftJoin(eventReaderStates, eq(eventReaderStates.eventId, eventItems.eventId))
      // Newly queued first versions wait for analysis before receiving a stable event identity.
      .where(and(kept, sql`(${!waitForAnalysis} or ${items.analysisStatus} <> 'pending' or ${items.analysisVersion} is null
        or ${items.contentRevision} > 1 or ${eventItems.itemId} is not null)`, sql`(${eventItems.itemId} is null or ${eventItems.sourceRevision} <> ${items.contentRevision}
        or ${eventItems.signalFingerprint} is distinct from ${fingerprint})`))
      .orderBy(asc(items.contentObservedAt), asc(items.id)).limit(EVENT_PROJECTION_BATCH_SIZE).for("share", { of: items });
    if (!rows.length) return 0;
    const contextFields = { id: items.id, platform: items.platform, source: items.authorName, title: items.title,
      translatedTitle: items.translatedTitle, excerpt: items.aiSummary, tags: items.topicTags, score: items.informationValueScore,
      reason: items.editorialReason, date: items.publishedAt, eventId: eventItems.eventId, manual: eventItems.manual,
      eventSignal: items.eventSignal, followed: eventReaderStates.followed };
    const recent = await tx.select(contextFields).from(items).innerJoin(eventItems, eq(items.id, eventItems.itemId))
      .leftJoin(eventReaderStates, eq(eventReaderStates.eventId, eventItems.eventId))
      .where(and(kept, gte(items.publishedAt, new Date(now.getTime() - 14 * 86_400_000))))
      .orderBy(desc(items.publishedAt)).limit(2000);
    const followed = await tx.select(contextFields).from(items).innerJoin(eventItems, eq(items.id, eventItems.itemId))
      .innerJoin(eventReaderStates, eq(eventReaderStates.eventId, eventItems.eventId))
      .where(and(kept, eq(eventReaderStates.followed, true))).orderBy(asc(items.publishedAt)).limit(2000);
    const context = [...new Map([...recent, ...followed, ...rows].map(row => [row.id, row])).values()];
    const candidates = context.map((row): EventCandidate => ({
      id: row.id, platform: row.platform, source: row.source ?? row.platform,
      title: row.translatedTitle || row.title || "", excerpt: row.excerpt ?? "",
      tags: row.tags, score: row.score ?? 0, whyKept: row.reason ?? "", date: row.date.toISOString(),
      eventId: row.eventId ?? undefined, manual: row.manual ?? false,
      eventSignal: row.eventSignal,
      followed: Boolean(row.followed),
    }));
    const assignments = planEventAssignments(candidates);
    const events = [...new Map(assignments.map((assignment) => [assignment.eventId, assignment])).values()];
    if (events.length) await tx.insert(contentEvents).values(events.map((event) => ({
      id: event.eventId, title: event.title, ruleVersion: EVENT_RULE_VERSION,
    }))).onConflictDoNothing();
    if (assignments.length) await tx.insert(eventItems).values(assignments.map(({ itemId, eventId }) => ({ itemId, eventId }))).onConflictDoNothing();
    const assigned = new Map(assignments.map(a => [a.itemId, a.eventId]));
    const histories = new Map<string, DevelopmentHistory[]>();
    for (const row of [...rows].sort((a, b) => a.discoveredAt.getTime() - b.discoveredAt.getTime() || a.id.localeCompare(b.id))) {
      const eventId = row.eventId ?? assigned.get(row.id);
      if (!eventId) continue;
      const inputs = developmentInputs({ itemId: row.id, sourceRevision: row.sourceRevision,
        projectedRevision: row.projectedRevision ?? 0, title: row.title || row.translatedTitle || "", bodyText: row.contentHtml && row.platform !== "x" ? htmlDocumentText(row.contentHtml) : row.bodyText, changeKind: row.changeKind, eventSignal: row.eventSignal });
      if (inputs.length) {
        let history = histories.get(eventId);
        if (!history) {
          history = await tx.select({ developmentKey: eventDevelopments.developmentKey, eventRevision: eventDevelopments.eventRevision })
            .from(eventDevelopments).where(eq(eventDevelopments.eventId, eventId));
          histories.set(eventId, history);
        }
        const fresh = selectFreshDevelopments(inputs, history);
        if (fresh.length) {
          const at = row.projectedRevision ? row.observedAt : row.date;
          // A later analysis of the same text only establishes a baseline; it is not new news.
          const baseline = row.projectedRevision === row.sourceRevision || (Boolean(row.projectedRevision) && row.changeKind === "enrichment");
          let revision = 0;
          const change = fresh.find(input => input.notify);
          if (!baseline && change) {
            const [event] = await tx.update(contentEvents).set({
              revision: sql`${contentEvents.revision} + 1`,
              activityAt: sql`greatest(coalesce(${contentEvents.activityAt}, ${at.toISOString()}::timestamptz), ${at.toISOString()}::timestamptz)`,
              latestChange: change.label, updatedAt: now,
            }).where(eq(contentEvents.id, eventId)).returning({ revision: contentEvents.revision });
            revision = event.revision;
          }
          const developments = fresh.map(({ notify, ...input }) => ({ ...input, eventId,
            eventRevision: notify ? revision : 0, itemId: row.id, sourceRevision: row.sourceRevision, firstSeenAt: at }));
          await tx.insert(eventDevelopments).values(developments);
          history.push(...developments);
        }
      }
      await tx.update(eventItems).set({ sourceRevision: row.sourceRevision, signalFingerprint: row.fingerprint }).where(eq(eventItems.itemId, row.id));
    }
    return assignments.length;
  });
}
