import type { PlatformType } from "@/connectors/types";

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
}

export interface RelatedEventSource {
  platform: PlatformType;
  source: string;
  title: string;
  url?: string;
}

const GENERIC_TAGS = new Set(["ai", "人工智能", "资讯", "新闻", "观点", "行业"]);

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

export function isLikelySameEvent(
  left: ClusterableReaderItem,
  right: ClusterableReaderItem,
  maxDistanceMs = 60 * 60 * 60 * 1_000,
): boolean {
  if (left.source === right.source && left.platform === right.platform) return false;
  if (Math.abs(timestamp(left.date) - timestamp(right.date)) > maxDistanceMs) return false;
  const leftTitle = normalizeEventTitle(left.title);
  const rightTitle = normalizeEventTitle(right.title);
  if (leftTitle.length < 8 || rightTitle.length < 8) return false;

  const similarity = eventTitleSimilarity(leftTitle, rightTitle);
  if (similarity >= 0.58) return true;
  return similarity >= 0.38 && sharedMeaningfulTags(left.tags, right.tags) >= 2;
}

function primaryValue(item: ClusterableReaderItem): number {
  return item.score + (item.whyKept ? 5 : 0) + (item.excerpt.length >= 40 ? 3 : 0);
}

export function clusterReaderItems<T extends ClusterableReaderItem>(items: T[]): Array<T & { relatedSources: RelatedEventSource[] }> {
  const groups: T[][] = [];
  for (const item of items) {
    const group = groups.find((candidate) => candidate.some((member) => isLikelySameEvent(member, item)));
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

export function buildFeaturedFeed<T extends ClusterableReaderItem>(
  items: T[],
  options: { maxItems?: number; balancePlatforms?: boolean } = {},
): Array<T & { relatedSources: RelatedEventSource[] }> {
  const maxItems = options.maxItems ?? 36;
  const eligible = items.filter((item) =>
    item.score >= 60
      && item.title.trim().length >= 4
      && item.excerpt.trim().length >= 20
      && item.whyKept.trim().length >= 12,
  );
  const clustered = clusterReaderItems(eligible);
  if (!options.balancePlatforms) return clustered.slice(0, maxItems);

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
  const corroboration = Math.min(item.relatedSources?.length ?? 0, 4) * 6;
  const completeness = (item.whyKept ? 4 : 0) + (item.excerpt.length >= 40 ? 2 : 0);
  return item.score + freshness + corroboration + completeness;
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
