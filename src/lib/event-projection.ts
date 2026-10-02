import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { contentEvents, eventItems, items } from "@/db/schema";
import { conflictingEventIdentity, isLikelySameEvent, type ClusterableReaderItem } from "@/lib/content-clustering";

export const EVENT_RULE_VERSION = "title-v2-version-guard";
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
    const match = [...groups].find(([, members]) =>
      members.every((member) => !conflictingEventIdentity(member.title, item.title))
      && members.some((member) => isLikelySameEvent(member, item)),
    );
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
  return db.transaction(async (tx) => {
    const lock = await tx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(hashtext('jianwei:event-projection')) as locked`);
    if (!lock[0]?.locked) return 0;
    const rows = await tx.select({
      id: items.id, platform: items.platform, source: items.authorName,
      title: items.title, translatedTitle: items.translatedTitle, excerpt: items.aiSummary,
      tags: items.topicTags, score: items.informationValueScore, reason: items.editorialReason,
      date: items.publishedAt, eventId: eventItems.eventId, manual: eventItems.manual,
    }).from(items).leftJoin(eventItems, eq(items.id, eventItems.itemId))
      .where(and(gte(items.publishedAt, new Date(now.getTime() - 14 * 86_400_000)), sql`
        exists (select 1 from item_matches im where im.item_id = ${items.id} and im.retention_status = 'kept')
      `)).orderBy(desc(items.publishedAt)).limit(2000);
    const candidates = rows.map((row): EventCandidate => ({
      id: row.id, platform: row.platform, source: row.source ?? row.platform,
      title: row.translatedTitle || row.title || "", excerpt: row.excerpt ?? "",
      tags: row.tags, score: row.score ?? 0, whyKept: row.reason ?? "", date: row.date.toISOString(),
      eventId: row.eventId ?? undefined, manual: row.manual ?? false,
    }));
    const assignments = planEventAssignments(candidates);
    const events = [...new Map(assignments.map((assignment) => [assignment.eventId, assignment])).values()];
    if (events.length) await tx.insert(contentEvents).values(events.map((event) => ({
      id: event.eventId, title: event.title, ruleVersion: EVENT_RULE_VERSION,
    }))).onConflictDoNothing();
    if (assignments.length) await tx.insert(eventItems).values(assignments.map(({ itemId, eventId }) => ({ itemId, eventId }))).onConflictDoNothing();
    return assignments.length;
  });
}
