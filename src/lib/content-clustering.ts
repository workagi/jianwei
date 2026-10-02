import type { PlatformType } from "@/connectors/types";
import { claimStage } from "./event-claims";
import { sameEventOccurrence, type EventSignal } from "./event-signals";

export interface ClusterableReaderItem {
  id: string;
  platform: PlatformType;
  source: string;
  title: string;
  excerpt: string;
  url?: string;
  tags: string[];
  score: number;
  whyKept: string;
  date: string;
  eventId?: string;
  eventDate?: string;
  eventPreferredItemId?: string;
  eventSignal?: EventSignal | null;
  followed?: boolean;
}

export interface RelatedEventSource {
  platform: PlatformType;
  source: string;
  title: string;
  url?: string;
}

const GENERIC_TAGS = new Set(["ai", "人工智能", "资讯", "新闻", "观点", "行业"]);
export const MAX_EVENT_DISTANCE_MS = 60 * 60 * 60 * 1_000;

function eventDatesWithinWindow(left: string, right: string, maxDistanceMs: number): boolean {
  const a = Date.parse(left);
  const b = Date.parse(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= maxDistanceMs;
}

function timestamp(value: string): number {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeEventTitle(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^(?:重磅|突发|刚刚|官宣|独家|深度|解读|消息称)[：:\s-]*/g, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();
}

function bigrams(value: string): Set<string> {
  const compact = normalizeEventTitle(value);
  const output = new Set<string>();
  if (compact.length < 2) return output;
  for (let index = 0; index < compact.length - 1; index += 1) {
    output.add(compact.slice(index, index + 2));
  }
  return output;
}

export function eventTitleSimilarity(left: string, right: string): number {
  const a = bigrams(left);
  const b = bigrams(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function sharedMeaningfulTags(left: string[], right: string[]): number {
  const normalized = new Set(
    left
      .map((tag) => tag.trim().toLocaleLowerCase())
      .filter((tag) => tag.length >= 2 && !GENERIC_TAGS.has(tag)),
  );
  return right
    .map((tag) => tag.trim().toLocaleLowerCase())
    .filter((tag) => tag.length >= 2 && !GENERIC_TAGS.has(tag) && normalized.has(tag)).length;
}

/** Product versions and explicit dates are identity evidence, not stop words. */
export function conflictingEventIdentity(left: string, right: string): boolean {
  const identities = (title: string) => {
    const result = new Map<string, Set<string>>();
    for (const match of title.normalize("NFKC").toLowerCase().matchAll(/\b([a-z][a-z0-9]*(?:[- ][a-z]+)*)[- ]?v?(\d+(?:\.\d+)*(?:[-a-z0-9]*)?)/g)) {
      const versions = result.get(match[1]) ?? new Set<string>();
      versions.add(match[2]);
      result.set(match[1], versions);
    }
    const dates = [...title.matchAll(/\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}\b/g)].map((match) => match[0].split(/[-/]/).map(Number).join("-"));
    if (dates.length) result.set("date", new Set(dates));
    return result;
  };
  const a = identities(left);
  const b = identities(right);
  return [...a].some(([entity, versions]) => b.has(entity) && ![...versions].some((version) => b.get(entity)!.has(version)));
}

export function isLikelySameEvent(
  left: ClusterableReaderItem,
  right: ClusterableReaderItem,
  maxDistanceMs = MAX_EVENT_DISTANCE_MS,
): boolean {
  if (conflictingEventIdentity(left.title, right.title)) return false;
  if (!eventDatesWithinWindow(left.date, right.date, maxDistanceMs)) return false;
  if (left.eventSignal && right.eventSignal) return sameEventOccurrence(left.eventSignal, right.eventSignal);
  if (left.source === right.source && left.platform === right.platform) return false;
  const aStage = claimStage(left.title), bStage = claimStage(right.title);
  if (aStage !== bStage && aStage !== "unknown" && bStage !== "unknown") return false;
  const leftTitle = normalizeEventTitle(left.title);
  const rightTitle = normalizeEventTitle(right.title);
  if (leftTitle.length < 8 || rightTitle.length < 8) return false;

  const similarity = eventTitleSimilarity(leftTitle, rightTitle);
  if (similarity >= 0.58) return true;
  return similarity >= 0.38 && sharedMeaningfulTags(left.tags, right.tags) >= 2;
}

/** A matching neighbour cannot bridge conflicting identities or extend the event's time window. */
export function canJoinEventGroup(members: ClusterableReaderItem[], item: ClusterableReaderItem): boolean {
  return members.every((member) =>
    !conflictingEventIdentity(member.title, item.title)
      && !(member.eventSignal && item.eventSignal && !sameEventOccurrence(member.eventSignal, item.eventSignal))
      && eventDatesWithinWindow(member.date, item.date, MAX_EVENT_DISTANCE_MS),
  ) && members.some((member) => isLikelySameEvent(member, item));
}

function primaryValue(item: ClusterableReaderItem): number {
  return item.score + (item.whyKept ? 5 : 0) + (item.excerpt.length >= 40 ? 3 : 0);
}

export function clusterReaderItems<T extends ClusterableReaderItem>(items: T[]): Array<T & { relatedSources: RelatedEventSource[] }> {
  const groups: T[][] = [];
  for (const item of items) {
    const group = groups.find((candidate) => canJoinEventGroup(candidate, item));
    if (group) group.push(item);
    else groups.push([item]);
  }

  return groups
    .map((group) => {
      const ordered = [...group].sort((a, b) => {
        const valueDifference = primaryValue(b) - primaryValue(a);
        return valueDifference || timestamp(b.date) - timestamp(a.date);
      });
      const primary = ordered[0];
      const seen = new Set<string>();
      const relatedSources = ordered.slice(1).flatMap((item) => {
        const key = `${item.platform}:${item.source}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ platform: item.platform, source: item.source, title: item.title, url: item.url }];
      });
      return { ...primary, relatedSources };
    })
    .sort((a, b) => timestamp(b.date) - timestamp(a.date));
}

/** Keep each source's best candidate, the preferred item and the date baseline between read batches. */
export function compactEventMembers<T extends ClusterableReaderItem>(items: T[]): T[] {
  const sources = new Map<string, T>(), oldest = new Map<string, T>(), preferred = new Map<string, T>();
  for (const item of items) {
    const event = item.eventId ?? `item:${item.id}`;
    const key = `${event}:${item.platform}:${item.source.toLowerCase()}`;
    const previous = sources.get(key);
    if (!previous || primaryValue(item) > primaryValue(previous)
      || (primaryValue(item) === primaryValue(previous) && timestamp(item.date) > timestamp(previous.date))) sources.set(key, item);
    if (!oldest.has(event) || timestamp(item.date) < timestamp(oldest.get(event)!.date)) oldest.set(event, item);
    if (item.id === item.eventPreferredItemId) preferred.set(event, item);
  }
  return [...new Map([...sources.values(), ...oldest.values(), ...preferred.values()].map(item => [item.id, item])).values()];
}

/** Reads persisted identities only. Missing background assignments remain separate cards. */
export function groupPersistedEvents<T extends ClusterableReaderItem>(items: T[]): Array<T & { relatedSources: RelatedEventSource[] }> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = item.eventId ?? `item:${item.id}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const ordered = [...group].sort((a, b) => primaryValue(b) - primaryValue(a) || timestamp(b.date) - timestamp(a.date));
    const preferredId = ordered[0].eventPreferredItemId;
    const primary = ordered.find(item => item.id === preferredId) ?? ordered[0];
    const seen = new Set([`${primary.platform}:${primary.source.toLowerCase()}`]);
    const relatedSources = ordered.filter(item => item.id !== primary.id).flatMap((item) => {
      const key = `${item.platform}:${item.source.toLowerCase()}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ platform: item.platform, source: item.source, title: item.title, url: item.url }];
    });
    const date = primary.eventDate ?? [...group].sort((a, b) => timestamp(a.date) - timestamp(b.date))[0].date;
    return { ...primary, date, relatedSources };
  }).sort((a, b) => timestamp(b.date) - timestamp(a.date));
}

export function buildFeaturedFeed<T extends ClusterableReaderItem>(
  items: T[],
  options: { maxItems?: number; balancePlatforms?: boolean; persisted?: boolean } = {},
): Array<T & { relatedSources: RelatedEventSource[] }> {
  const maxItems = options.maxItems ?? 36;
  const eligible = items.filter((item) =>
    item.score >= 60
      && item.title.trim().length >= 4
      && item.excerpt.trim().length >= 20
      && item.whyKept.trim().length >= 12,
  );
  const clustered = (options.persisted ? groupPersistedEvents(eligible) : clusterReaderItems(eligible))
    .sort((a, b) => featuredEventRank(b) - featuredEventRank(a) || timestamp(b.date) - timestamp(a.date));
  if (!options.balancePlatforms) return clustered.slice(0, maxItems).sort((a, b) => timestamp(b.date) - timestamp(a.date));

  const softLimit = Math.max(4, Math.ceil(maxItems / 4));
  const sourceSoftLimit = 5;
  const counts = new Map<PlatformType, number>();
  const sourceCounts = new Map<string, number>();
  const selected: typeof clustered = [];
  const overflow: typeof clustered = [];
  for (const item of clustered) {
    const count = counts.get(item.platform) ?? 0;
    const sourceKey = `${item.platform}:${item.source.toLocaleLowerCase()}`;
    const sourceCount = sourceCounts.get(sourceKey) ?? 0;
    if (count < softLimit && sourceCount < sourceSoftLimit) {
      selected.push(item);
      counts.set(item.platform, count + 1);
      sourceCounts.set(sourceKey, sourceCount + 1);
    } else {
      overflow.push(item);
    }
  }
  if (selected.length < maxItems) {
    for (const item of overflow) {
      if (selected.length >= maxItems) break;
      const sourceKey = `${item.platform}:${item.source.toLocaleLowerCase()}`;
      const sourceCount = sourceCounts.get(sourceKey) ?? 0;
      if (sourceCount >= sourceSoftLimit) continue;
      selected.push(item);
      sourceCounts.set(sourceKey, sourceCount + 1);
    }
  }
  // A soft diversity target may not leave an otherwise useful list half empty.
  for (const item of overflow) {
    if (selected.length >= maxItems) break;
    if (!selected.includes(item)) selected.push(item);
  }
  return selected
    .sort((a, b) => timestamp(b.date) - timestamp(a.date))
    .slice(0, maxItems);
}

export function featuredEventRank(
  item: ClusterableReaderItem & { relatedSources?: RelatedEventSource[] },
  now = Date.now(),
): number {
  const ageHours = Math.max(0, (now - timestamp(item.date)) / (60 * 60 * 1_000));
  const freshness = Math.max(0, 18 - ageHours * 0.3);
  const completeness = (item.whyKept ? 4 : 0) + (item.excerpt.length >= 40 ? 2 : 0);
  return item.score + freshness + completeness;
}

export function selectTopFeaturedEvents<T extends ClusterableReaderItem & { relatedSources?: RelatedEventSource[] }>(
  items: T[],
  options: { limit?: number; now?: number } = {},
): T[] {
  const limit = options.limit ?? 3;
  const ranked = [...items].sort((a, b) =>
    featuredEventRank(b, options.now) - featuredEventRank(a, options.now) || timestamp(b.date) - timestamp(a.date),
  );
  const selected: T[] = [];
  const overflow: T[] = [];
  const sources = new Set<string>();
  for (const item of ranked) {
    const sourceKey = `${item.platform}:${item.source.toLocaleLowerCase()}`;
    if (!sources.has(sourceKey) && selected.length < limit) {
      selected.push(item);
      sources.add(sourceKey);
    } else {
      overflow.push(item);
    }
  }
  if (selected.length < limit) selected.push(...overflow.slice(0, limit - selected.length));
  return selected.slice(0, limit);
}

/** Rank the bounded candidate population before applying the browse-list cap. */
export function buildFeaturedSelection<T extends ClusterableReaderItem>(items: T[], options: { balancePlatforms?: boolean; persisted?: boolean; maxItems?: number } = {}) {
  const candidates = buildFeaturedFeed(items, { persisted: options.persisted, maxItems: Number.MAX_SAFE_INTEGER });
  const topItems = selectTopFeaturedEvents(candidates);
  const browse = buildFeaturedFeed(items, options);
  const selected = new Map<string, typeof candidates[number]>();
  for (const item of [...topItems, ...browse]) {
    if (selected.size >= (options.maxItems ?? 36)) break;
    selected.set(item.eventId ?? item.id, item);
  }
  return { topItems, items: [...selected.values()].sort((a, b) => timestamp(b.date) - timestamp(a.date)) };
}
