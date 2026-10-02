import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { contentEvents, eventDevelopments, eventReaderStates, items } from "@/db/schema";

/** Validate the rendered revision, never mark unseen newer changes as read. */
export async function updateEventReaderState(eventId: string, input: { readRevision?: number; followed?: boolean }) {
  return db.transaction(async tx => {
    const [event] = await tx.select({ revision: contentEvents.revision }).from(contentEvents)
      .where(eq(contentEvents.id, eventId)).for("update");
    if (!event) return "not_found" as const;
    if (input.readRevision !== undefined && (input.readRevision < 0 || input.readRevision > event.revision)) return "invalid_revision" as const;
    await tx.insert(eventReaderStates).values({ eventId, readRevision: input.readRevision ?? 0,
      followed: input.followed ?? false, readAt: input.readRevision === undefined ? null : new Date() })
      .onConflictDoUpdate({ target: eventReaderStates.eventId, set: {
        ...(input.readRevision !== undefined ? { readRevision: sql`greatest(${eventReaderStates.readRevision}, ${input.readRevision})`, readAt: new Date() } : {}),
        ...(input.followed !== undefined ? { followed: input.followed } : {}),
      } });
    return "ok" as const;
  });
}

export async function loadEventDevelopments(eventIds: string[], beforeRevision?: number) {
  if (!eventIds.length) return [];
  // Three revisions per page; one revision may contain several pieces of evidence.
  const rows = await db.select({ id: eventDevelopments.id, eventId: eventDevelopments.eventId, revision: eventDevelopments.eventRevision,
    label: eventDevelopments.label, title: eventDevelopments.title, evidence: eventDevelopments.evidence,
    url: items.canonicalUrl, at: eventDevelopments.firstSeenAt }).from(eventDevelopments)
    .leftJoin(items, eq(items.id, eventDevelopments.itemId))
    .where(and(inArray(eventDevelopments.eventId, eventIds), beforeRevision !== undefined
      ? sql`${eventDevelopments.eventRevision} >= greatest(${beforeRevision} - 3, 1) and ${eventDevelopments.eventRevision} < ${beforeRevision}`
      : sql`${eventDevelopments.eventRevision} > (select greatest(revision - 3, 0) from content_events where id = ${eventDevelopments.eventId})`))
    .orderBy(desc(eventDevelopments.eventRevision));
  return rows;
}

export async function loadEventDetail(eventId: string, beforeRevision?: number) {
  const [event] = await db.select({ id: contentEvents.id, title: contentEvents.title, revision: contentEvents.revision,
    latestChange: contentEvents.latestChange, readRevision: eventReaderStates.readRevision, followed: eventReaderStates.followed })
    .from(contentEvents).leftJoin(eventReaderStates, eq(eventReaderStates.eventId, contentEvents.id)).where(eq(contentEvents.id, eventId));
  if (!event) return null;
  const before = Math.min(beforeRevision ?? event.revision + 1, event.revision + 1);
  return { ...event, before, developments: await loadEventDevelopments([eventId], before) };
}
