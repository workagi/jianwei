import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface TrendRadarPlatformSource {
  id: string;
  name: string;
  expectedDomain?: string;
  enabled: boolean;
  custom?: boolean;
}

export interface TrendRadarRssFeed {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  maxAgeDays?: number;
}

export interface TrendRadarSourcesConfig {
  configPath: string;
  platformsEnabled: boolean;
  rssEnabled: boolean;
  platformSources: TrendRadarPlatformSource[];
  rssFeeds: TrendRadarRssFeed[];
}

const DEFAULT_CONFIG_DIR = path.join(process.cwd(), "infra", "trendradar", "config");
const CONFIG_PATH = path.join(process.env.TRENDRADAR_CONFIG_DIR ?? DEFAULT_CONFIG_DIR, "config.yaml");

/**
 * TrendRadar hot-list IDs are not arbitrary: they must be supported by its
 * upstream newsnow source. Keep a curated catalog so users can toggle common
 * sources without knowing YAML or platform IDs. Unknown IDs already present in
 * config.yaml are preserved as custom enabled sources.
 */
export const TRENDRADAR_PLATFORM_CATALOG: TrendRadarPlatformSource[] = [
  { id: "toutiao", name: "今日头条", expectedDomain: "toutiao.com", enabled: true },
  { id: "baidu", name: "百度热搜", expectedDomain: "baidu.com", enabled: true },
  { id: "wallstreetcn-hot", name: "华尔街见闻", expectedDomain: "wallstreetcn.com", enabled: true },
  { id: "thepaper", name: "澎湃新闻", expectedDomain: "thepaper.cn", enabled: true },
  { id: "bilibili-hot-search", name: "bilibili 热搜", expectedDomain: "bilibili.com", enabled: true },
  { id: "cls-hot", name: "财联社热门", expectedDomain: "cls.cn", enabled: true },
  { id: "ifeng", name: "凤凰网", expectedDomain: "ifeng.com", enabled: true },
  { id: "tieba", name: "贴吧", expectedDomain: "baidu.com", enabled: true },
  { id: "weibo", name: "微博", expectedDomain: "weibo.com", enabled: true },
  { id: "douyin", name: "抖音", expectedDomain: "douyin.com", enabled: true },
  { id: "zhihu", name: "知乎", expectedDomain: "zhihu.com", enabled: true },
];

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function parseScalar(line: string, key: string): string | undefined {
  const match = new RegExp(`^\\s+${key}:\\s*(.+?)\\s*(?:#.*)?$`).exec(line);
  return match ? unquote(match[1]) : undefined;
}

function parseBooleanInSection(lines: string[], sectionName: string): boolean {
  const sectionIndex = lines.findIndex((line) => line.trim() === `${sectionName}:`);
  if (sectionIndex < 0) return false;
  for (let i = sectionIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^[A-Za-z_][\w-]*:\s*$/.test(line)) break;
    const value = parseScalar(line, "enabled");
    if (value !== undefined) return value !== "false";
  }
  return false;
}

function findListBlock(lines: string[], sectionName: string, listName: string): { start: number; end: number } {
  const sectionIndex = lines.findIndex((line) => line.trim() === `${sectionName}:`);
  if (sectionIndex < 0) throw new Error(`TREND_CONFIG_SECTION_NOT_FOUND:${sectionName}`);

  const listIndex = lines.findIndex((line, index) => index > sectionIndex && line === `  ${listName}:`);
  if (listIndex < 0) throw new Error(`TREND_CONFIG_LIST_NOT_FOUND:${sectionName}.${listName}`);

  let end = lines.length;
  for (let i = listIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^[A-Za-z_][\w-]*:\s*$/.test(line) || /^# ={8,}/.test(line)) {
      end = i;
      break;
    }
  }
  return { start: listIndex + 1, end };
}

function parseObjectList(block: string[]): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  let current: Record<string, string> | undefined;

  for (const line of block) {
    const itemMatch = /^ {4}- ([A-Za-z_][\w-]*):\s*(.+?)\s*(?:#.*)?$/.exec(line);
    if (itemMatch) {
      current = { [itemMatch[1]]: unquote(itemMatch[2]) };
      rows.push(current);
      continue;
    }
    if (!current) continue;
    const propMatch = /^ {6}([A-Za-z_][\w-]*):\s*(.+?)\s*(?:#.*)?$/.exec(line);
    if (propMatch) {
      current[propMatch[1]] = unquote(propMatch[2]);
    }
  }
  return rows;
}

function normalizePlatformRows(rows: Record<string, string>[]): TrendRadarPlatformSource[] {
  const current = new Map(
    rows
      .filter((row) => row.id)
      .map((row) => [
        row.id,
        {
          id: row.id,
          name: row.name || row.id,
          expectedDomain: row.expected_domain,
          enabled: row.enabled !== "false",
        } satisfies TrendRadarPlatformSource,
      ]),
  );

  const catalog = TRENDRADAR_PLATFORM_CATALOG.map((source) => ({
    ...source,
    enabled: current.has(source.id),
    name: current.get(source.id)?.name ?? source.name,
    expectedDomain: current.get(source.id)?.expectedDomain ?? source.expectedDomain,
  }));
  const catalogIds = new Set(catalog.map((source) => source.id));
  const custom = [...current.values()]
    .filter((source) => !catalogIds.has(source.id))
    .map((source) => ({ ...source, custom: true }));
  return [...catalog, ...custom];
}

function normalizeRssRows(rows: Record<string, string>[]): TrendRadarRssFeed[] {
  return rows
    .filter((row) => row.id && row.name && row.url)
    .map((row) => ({
      id: row.id,
      name: row.name,
      url: row.url,
      enabled: row.enabled !== "false",
      maxAgeDays: row.max_age_days === undefined ? undefined : Number(row.max_age_days),
    }));
}

export async function loadTrendRadarSourcesConfig(): Promise<TrendRadarSourcesConfig> {
  const raw = await readFile(CONFIG_PATH, "utf8");
  const lines = raw.split(/\r?\n/);
  const platformBlock = findListBlock(lines, "platforms", "sources");
  const rssBlock = findListBlock(lines, "rss", "feeds");

  return {
    configPath: CONFIG_PATH,
    platformsEnabled: parseBooleanInSection(lines, "platforms"),
    rssEnabled: parseBooleanInSection(lines, "rss"),
    platformSources: normalizePlatformRows(parseObjectList(lines.slice(platformBlock.start, platformBlock.end))),
    rssFeeds: normalizeRssRows(parseObjectList(lines.slice(rssBlock.start, rssBlock.end))),
  };
}

function writePlatformSources(sources: TrendRadarPlatformSource[]): string[] {
  return sources
    .filter((source) => source.enabled)
    .flatMap((source) => [
      `    - id: ${quote(source.id)}`,
      `      name: ${quote(source.name || source.id)}`,
      ...(source.expectedDomain ? [`      expected_domain: ${quote(source.expectedDomain)}`] : []),
    ]);
}

function writeRssFeeds(feeds: TrendRadarRssFeed[]): string[] {
  return feeds.flatMap((feed) => [
    `    - id: ${quote(feed.id)}`,
    `      name: ${quote(feed.name)}`,
    `      url: ${quote(feed.url)}`,
    ...(feed.enabled ? [] : [`      enabled: false`]),
    ...(Number.isFinite(feed.maxAgeDays) ? [`      max_age_days: ${feed.maxAgeDays}`] : []),
  ]);
}

function replaceListBlock(raw: string, sectionName: string, listName: string, replacement: string[]): string {
  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  const block = findListBlock(lines, sectionName, listName);
  const next = [...lines.slice(0, block.start), ...replacement, ...lines.slice(block.end)];
  return next.join(newline);
}

function setSectionEnabled(raw: string, sectionName: string, enabled: boolean): string {
  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  const sectionIndex = lines.findIndex((line) => line.trim() === `${sectionName}:`);
  if (sectionIndex < 0) throw new Error(`TREND_CONFIG_SECTION_NOT_FOUND:${sectionName}`);
  for (let i = sectionIndex + 1; i < lines.length; i += 1) {
    if (/^[A-Za-z_][\w-]*:\s*$/.test(lines[i])) break;
    if (/^ {2}enabled:\s*/.test(lines[i])) {
      lines[i] = lines[i].replace(/^ {2}enabled:\s*(true|false)/, `  enabled: ${enabled ? "true" : "false"}`);
      return lines.join(newline);
    }
  }
  lines.splice(sectionIndex + 1, 0, `  enabled: ${enabled ? "true" : "false"}`);
  return lines.join(newline);
}

function uniqueById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const row of rows) {
    const id = row.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({ ...row, id });
  }
  return result;
}

export async function saveTrendRadarSourcesConfig(input: {
  platformsEnabled: boolean;
  rssEnabled: boolean;
  platformSources: TrendRadarPlatformSource[];
  rssFeeds: TrendRadarRssFeed[];
}): Promise<TrendRadarSourcesConfig> {
  let raw = await readFile(CONFIG_PATH, "utf8");
  const platformSources = uniqueById(input.platformSources).map((source) => ({
    ...source,
    id: source.id.trim(),
    name: source.name.trim(),
    expectedDomain: source.expectedDomain?.trim() || undefined,
  }));
  const rssFeeds = uniqueById(input.rssFeeds).map((feed) => ({
    ...feed,
    id: feed.id.trim(),
    name: feed.name.trim(),
    url: feed.url.trim(),
    maxAgeDays: Number.isFinite(feed.maxAgeDays) ? feed.maxAgeDays : undefined,
  }));

  raw = setSectionEnabled(raw, "platforms", input.platformsEnabled);
  raw = setSectionEnabled(raw, "rss", input.rssEnabled);
  raw = replaceListBlock(raw, "platforms", "sources", writePlatformSources(platformSources));
  raw = replaceListBlock(raw, "rss", "feeds", writeRssFeeds(rssFeeds));
  await writeFile(CONFIG_PATH, raw, "utf8");
  return loadTrendRadarSourcesConfig();
}
