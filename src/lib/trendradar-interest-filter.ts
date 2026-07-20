import { readFile, writeFile } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { NormalizedItem } from "@/connectors/types";
import { trendRadarRssSourceEnabled } from "@/lib/trendradar-config";

/**
 * Wide sources often mention AI/开发者 only in the body. Reader and ingest both
 * require the interest hit to appear in the headline for these names, so the
 * database never accumulates "hidden" rows that still burn summary tokens.
 */
export const BROAD_TRENDRADAR_SOURCES = new Set([
  "IT之家",
  "Hacker News",
  "Product Hunt",
  "雅虎财经",
]);

interface InterestRules {
  include: RegExp[];
  exclude: RegExp[];
}

export interface TrendRadarInterestGroup {
  name: string;
  keywords: string[];
}

export interface TrendRadarInterestConfig {
  configPath: string;
  globalFilters: string[];
  groups: TrendRadarInterestGroup[];
}

const DEFAULT_CONFIG_DIR = path.join(process.cwd(), "infra", "trendradar", "config");
const CONFIG_DIR = process.env.TRENDRADAR_CONFIG_DIR ?? DEFAULT_CONFIG_DIR;
const FREQUENCY_WORDS_PATH = path.join(CONFIG_DIR, "frequency_words.txt");

const DEFAULT_INCLUDE = [
  /\bAI\b|人工智能|大模型|智能体|Agent|LLM/i,
  /Claude|OpenAI|Codex|GitHub|开源|编程|开发者/i,
  /芯片|机器人|自动驾驶|新能源|算力|云计算/i,
];

const DEFAULT_GROUPS: TrendRadarInterestGroup[] = [
  { name: "人工智能", keywords: ["AI", "人工智能", "大模型", "智能体", "Agent", "LLM"] },
  { name: "开发工具", keywords: ["Claude", "OpenAI", "Codex", "GitHub", "开源", "编程", "开发者"] },
  { name: "科技产业", keywords: ["芯片", "机器人", "自动驾驶", "新能源", "算力", "云计算"] },
];

let cachedRules: { mtimeMs: number; rules: InterestRules } | undefined;

const LEGACY_REGEX_EXPANSIONS = new Map<string, string[]>([
  ["/\\bAI\\b|人工智能|大模型|智能体|Agent|LLM/i", ["AI", "人工智能", "大模型", "智能体", "Agent", "LLM"]],
  ["/Claude|OpenAI|Codex|GitHub|开源|编程|开发者/i", ["Claude", "OpenAI", "Codex", "GitHub", "开源", "编程", "开发者"]],
  ["/芯片|机器人|自动驾驶|新能源|算力|云计算/i", ["芯片", "机器人", "自动驾驶", "新能源", "算力", "云计算"]],
  ["/芯片|机器人|自动驾驶|新能源|算力|云计算/", ["芯片", "机器人", "自动驾驶", "新能源", "算力", "云计算"]],
]);

function parsePattern(raw: string): RegExp | undefined {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;

  const regexMatch = /^\/(.+)\/([a-z]*)$/i.exec(trimmed);
  if (regexMatch) {
    try {
      return new RegExp(regexMatch[1], regexMatch[2]);
    } catch {
      return undefined;
    }
  }

  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (/^[A-Za-z0-9][A-Za-z0-9 _.-]*[A-Za-z0-9]$/.test(trimmed)) {
    return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "i");
  }
  return new RegExp(escaped, "i");
}

function expandKeywordForEditing(raw: string): string[] {
  const trimmed = raw.trim();
  return LEGACY_REGEX_EXPANSIONS.get(trimmed) ?? [trimmed];
}

export function parseFrequencyWordsConfig(raw: string): InterestRules {
  const editable = parseEditableFrequencyWordsConfig(raw);
  const include = editable.groups.flatMap((group) => group.keywords.map(parsePattern).filter((p): p is RegExp => Boolean(p)));
  const exclude = editable.globalFilters.map(parsePattern).filter((p): p is RegExp => Boolean(p));
  return { include, exclude };
}

export function parseEditableFrequencyWordsConfig(raw: string): Omit<TrendRadarInterestConfig, "configPath"> {
  const globalFilters: string[] = [];
  const groups: TrendRadarInterestGroup[] = [];
  let section: "include" | "exclude" | undefined;
  let currentGroup: TrendRadarInterestGroup | undefined;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed === "[GLOBAL_FILTER]") {
      section = "exclude";
      currentGroup = undefined;
      continue;
    }
    if (trimmed === "[WORD_GROUPS]") {
      section = "include";
      currentGroup = undefined;
      continue;
    }
    if (/^\[.+\]$/.test(trimmed)) {
      if (section === "include") {
        currentGroup = { name: trimmed.slice(1, -1).trim(), keywords: [] };
        groups.push(currentGroup);
      }
      continue;
    }

    if (section === "exclude") globalFilters.push(...expandKeywordForEditing(trimmed));
    else if (section === "include") {
      if (!currentGroup) {
        currentGroup = { name: "未分组", keywords: [] };
        groups.push(currentGroup);
      }
      currentGroup.keywords.push(...expandKeywordForEditing(trimmed));
    }
  }

  return {
    globalFilters,
    groups: groups.filter((group) => group.name && group.keywords.length > 0),
  };
}

export function serializeEditableFrequencyWordsConfig(input: Pick<TrendRadarInterestConfig, "globalFilters" | "groups">): string {
  const globalFilters = input.globalFilters.map((line) => line.trim()).filter(Boolean);
  const groups = input.groups
    .map((group) => ({
      name: group.name.trim(),
      keywords: group.keywords.map((line) => line.trim()).filter(Boolean),
    }))
    .filter((group) => group.name && group.keywords.length > 0);

  return [
    "# SignalDeck 站点榜单 / RSS 兴趣规则。",
    "# 后台「平台连接 → 榜单 / RSS 兴趣规则」会写入此文件。",
    "# 每行一个关键词；高级用户也可以填写 /.../i 形式的正则。",
    "",
    "[GLOBAL_FILTER]",
    ...globalFilters,
    "",
    "[WORD_GROUPS]",
    "",
    ...groups.flatMap((group) => [`[${group.name}]`, ...group.keywords, ""]),
  ].join("\n");
}

export async function loadTrendRadarInterestConfig(): Promise<TrendRadarInterestConfig> {
  const raw = await readFile(FREQUENCY_WORDS_PATH, "utf8");
  return { configPath: FREQUENCY_WORDS_PATH, ...parseEditableFrequencyWordsConfig(raw) };
}

export async function saveTrendRadarInterestConfig(input: Pick<TrendRadarInterestConfig, "globalFilters" | "groups">): Promise<TrendRadarInterestConfig> {
  await writeFile(FREQUENCY_WORDS_PATH, serializeEditableFrequencyWordsConfig(input), "utf8");
  resetTrendRadarInterestRulesForTests();
  return loadTrendRadarInterestConfig();
}

function loadRules(): InterestRules {
  const mtimeMs = (() => {
    try {
      return statSync(FREQUENCY_WORDS_PATH).mtimeMs;
    } catch {
      return -1;
    }
  })();
  if (cachedRules && cachedRules.mtimeMs === mtimeMs) return cachedRules.rules;

  let rules: InterestRules;
  try {
    rules = parseFrequencyWordsConfig(readFileSync(FREQUENCY_WORDS_PATH, "utf8"));
  } catch {
    rules = { include: DEFAULT_INCLUDE, exclude: [] };
  }
  if (rules.include.length === 0) {
    rules = { ...rules, include: DEFAULT_INCLUDE };
  }
  cachedRules = { mtimeMs, rules };
  return rules;
}

function trendRadarText(item: Pick<NormalizedItem, "title" | "text">): string {
  return [item.title, item.text].filter(Boolean).join("\n");
}

export function isTrendRadarInteresting(item: Pick<NormalizedItem, "title" | "text">): boolean {
  const text = trendRadarText(item);
  const rules = loadRules();
  if (rules.exclude.some((pattern) => pattern.test(text))) return false;
  return rules.include.some((pattern) => pattern.test(text));
}

/**
 * Single gate shared by ingest, reader, and model backfill.
 * Must stay identical: what can enter the DB is what can appear on the feed,
 * and only those rows may spend model tokens.
 */
export function passesTrendRadarReaderGate(item: {
  title?: string | null;
  text?: string | null;
  bodyText?: string | null;
  authorName?: string | null;
}): boolean {
  if (item.authorName && trendRadarRssSourceEnabled(item.authorName) === false) return false;
  const body = item.text ?? item.bodyText ?? "";
  const titleOnly = Boolean(item.authorName && BROAD_TRENDRADAR_SOURCES.has(item.authorName));
  return isTrendRadarInteresting({
    title: item.title ?? undefined,
    text: titleOnly ? "" : body,
  });
}

export function filterTrendRadarItems<
  T extends Pick<NormalizedItem, "title" | "text"> & { authorName?: string | null },
>(items: T[]): T[] {
  return items.filter((item) =>
    passesTrendRadarReaderGate({
      title: item.title,
      text: item.text,
      authorName: item.authorName,
    }),
  );
}

export function resetTrendRadarInterestRulesForTests() {
  cachedRules = undefined;
}

export function defaultTrendRadarInterestConfig(): Omit<TrendRadarInterestConfig, "configPath"> {
  return { globalFilters: ["震惊", "标题党"], groups: DEFAULT_GROUPS };
}
