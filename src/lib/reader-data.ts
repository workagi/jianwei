import { countItems, getItems, getMonitorsWithHealth, getWechatKeywordRuleFilters, loadApiCredentials } from "@/db/queries";
import { demoItems, demoMonitors } from "./demo-data";
import type { PlatformType } from "@/connectors/types";
import { decodeXQuotedPost } from "@/connectors/types";
import { sourceNameFromUrl } from "@/connectors/web/source-name";
import {
  deriveContentTypeId,
  deriveTopicTags,
  getContentTypeFilter,
  getContentTypeLabel,
  itemMatchesContentType,
  itemMatchesTopic,
  normalizeContentType,
  normalizeTopicLabel,
  normalizeTopicTags,
} from "@/lib/item-tags";
import { passesTrendRadarReaderGate } from "@/lib/trendradar-interest-filter";
import { TRENDRADAR_PLATFORM_CATALOG } from "@/lib/trendradar-config";
import { formatPollInterval } from "@/lib/monitor-schedule";
import { deriveRetentionDecision, normalizeRetentionReason } from "@/lib/content-retention";
import { normalizeSummaryForDisplay } from "@/lib/summarizer";
import { buildFeaturedFeed, type RelatedEventSource } from "@/lib/content-clustering";
import { createStructuredLogger } from "@/lib/structured-log";

const readerLog = createStructuredLogger({ service: "reader" });

const READER_PLATFORMS: PlatformType[] = ["x", "wechat", "web_search", "trendradar"];
const UNIFIED_FEED_PLATFORM_LIMIT = 18;
const DEFAULT_PLATFORM_WINDOW = 80;
const LOCAL_FILTER_WINDOW = 300;
export const READER_PAGE_SIZE = 50;
const MAX_LOCAL_FILTER_SCAN = 5_000;

/**
 * Reader-facing item shape. Produced by both the live DB path and the demo
 * fallback so the UI components never branch on the data source.
 */
export interface ReaderItem {
  id: string;
  platform: PlatformType;
  source: string;
  handle?: string;
  avatarUrl?: string;
  sourceKind: "x" | "wechat" | "web" | "rss" | "hotlist";
  statusBadge?: {
    label: string;
    tone: "ok" | "warning" | "muted";
    title: string;
  };
  time: string;
  date: string;
  title: string;
  excerpt: string;
  url?: string;
  /** Nested quoted post for X quote tweets. */
  quote?: {
    author: string;
    handle?: string;
    text: string;
    url?: string;
  };
  contentType: string;
  contentTypeLabel: string;
  tags: string[];
  score: number;
  whyKept: string;
  match: string;
  bookmarked: boolean;
  relatedSources?: RelatedEventSource[];
}

export interface AdminMonitorView {
  id: string;
  platform: PlatformType;
  title: string;
  detail: string;
  health: string;
  warning: boolean;
  statusDetail?: string;
  config: Record<string, unknown>;
  pollIntervalMinutes: number;
}

export interface AdminCredentialStatus {
  x: boolean;
  wechat: boolean;
  web_search: boolean;
  web_search_brave: boolean;
  web_search_tavily: boolean;
  web_search_serper: boolean;
  model_api: boolean;
}

export interface ReaderKeywordRuleFilter {
  id: string;
  name: string;
  itemCount: number;
}

export interface ReaderFeedResult {
  items: ReaderItem[];
  usingDemo: boolean;
  total: number;
  totalIsExact: boolean;
  page: number;
  pageSize: number;
  hasPrevious: boolean;
  hasNext: boolean;
  balancedOverview: boolean;
}

export function normalizeReaderPage(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.floor(parsed);
}

export function normalizeXDisplayText(value: string): string {
  return value
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function readerDisplayTitle(input: { platform: PlatformType; title?: string | null; translatedTitle?: string | null; bodyText: string }): string {
  if (input.platform === "x") {
    const translatedPost = normalizeXDisplayText(input.translatedTitle ?? "");
    if (translatedPost) return translatedPost;
    const post = normalizeXDisplayText(input.bodyText);
    if (post) return post;
  }
  const translatedTitle = input.translatedTitle?.trim();
  if (translatedTitle) return translatedTitle;
  const title = input.title?.trim();
  if (title) return title;
  if (input.platform === "x") return "空白推文";
  return "(无标题)";
}

export function readerRecommendationReason(input: { reason?: string | null; source?: string | null }): string {
  if (input.source !== "model") return "";
  return normalizeRetentionReason(input.reason) ?? "";
}

export function trendRadarSourceKind(authorName?: string | null, authorHandle?: string | null): "rss" | "hotlist" {
  const name = authorName?.trim().toLowerCase();
  const handle = authorHandle?.trim().toLowerCase();
  const isHotlist = TRENDRADAR_PLATFORM_CATALOG.some((source) => (
    source.name.toLowerCase() === name || source.id.toLowerCase() === handle
  ));
  return isHotlist ? "hotlist" : "rss";
}

function feedResult(input: {
  items: ReaderItem[];
  usingDemo: boolean;
  total: number;
  totalIsExact?: boolean;
  page: number;
  balancedOverview?: boolean;
}): ReaderFeedResult {
  const pageSize = READER_PAGE_SIZE;
  return {
    ...input,
    totalIsExact: input.totalIsExact ?? true,
    pageSize,
    hasPrevious: !input.balancedOverview && input.page > 1,
    hasNext: !input.balancedOverview && input.page * pageSize < input.total,
    balancedOverview: input.balancedOverview ?? false,
  };
}

const healthLabel: Record<string, string> = {
  pending: "待运行",
  healthy: "正常",
  auth_required: "需要授权",
  rate_limited: "限流",
  budget_exhausted: "额度用尽",
  failed: "失败",
};

function webSearchProviderLabel(config: Record<string, unknown>): string {
  const provider = typeof config.provider === "string" ? config.provider : "brave";
  if (provider === "tavily") return "Tavily";
  if (provider === "serper") return "Serper";
  return "Brave";
}

export function monitorDetail(
  platform: PlatformType,
  pollIntervalMinutes: number,
  config: Record<string, unknown> = {},
): string {
  const cadence = formatPollInterval(pollIntervalMinutes);
  if (platform === "trendradar") return `系统内置 · ${cadence}`;
  if (platform === "web_search") return `${webSearchProviderLabel(config)} · ${cadence}`;
  if (platform === "wechat" && config.kind === "keyword_rule") return `公众号关键词 · ${cadence}`;
  if (platform === "x") {
    const username = typeof config.username === "string" ? config.username.replace(/^@/, "") : "";
    return `${username ? `@${username} · ` : ""}${cadence}`;
  }
  return cadence;
}

export function deriveMonitorHealth(row: {
  enabled: boolean;
  lastSuccessAt: Date | string | null;
  failureCount: number;
  lastError: string | null;
  healthStatus: string | null;
  itemCount?: number | null;
  latestRunStatus?: string | null;
  latestRunStartedAt?: Date | string | null;
  latestRunFetchedCount?: number | null;
  latestRunErrorMessage?: string | null;
  latestSummaryStatus?: string | null;
  latestSummaryAttemptedCount?: number | null;
  latestSummarySucceededCount?: number | null;
  latestSummaryErrorCode?: string | null;
}): { health: string; warning: boolean; statusDetail?: string } {
  if (!row.enabled) {
    return {
      health: "已停用",
      warning: true,
      statusDetail: row.lastError ? `最后错误：${row.lastError}` : undefined,
    };
  }
  const itemCount = Number(row.itemCount ?? 0);
  if (row.latestRunStatus === "running") {
    const startedAt = row.latestRunStartedAt ? new Date(row.latestRunStartedAt).getTime() : 0;
    const ageMinutes = startedAt ? Math.floor((Date.now() - startedAt) / 60_000) : 0;
    if (ageMinutes > 10) {
      return {
        health: "采集中断",
        warning: true,
        statusDetail: `上次运行已持续 ${ageMinutes} 分钟，可能是 worker 重启或采集中断`,
      };
    }
    return {
      health: "采集中",
      warning: false,
      statusDetail: startedAt ? `已运行约 ${Math.max(ageMinutes, 1)} 分钟` : undefined,
    };
  }
  if (row.lastError) {
    if (row.lastError === "BUDGET_EXHAUSTED") return { health: "额度用尽", warning: true };
    if (/401|403|auth|unauthorized|forbidden/i.test(row.lastError)) {
      return { health: "需要授权", warning: true, statusDetail: "检查平台密钥或 WeRSS 扫码授权" };
    }
    if (/^WERSS_FEED_(?:STALE|NEVER_SYNCED)/.test(row.lastError)) {
      return {
        health: "公众号源停更",
        warning: true,
        statusDetail: "WeRSS 长时间没有同步该公众号；系统已保留任务并等待上游恢复",
      };
    }
    if (/^XAI_X_SEARCH_(?:429|5\d\d|TIMEOUT|NETWORK(?::[A-Z0-9_]+)?)$/.test(row.lastError)
      || row.lastError === "GATHER_TIMEOUT:x"
      || row.lastError === "fetch failed") {
      return { health: "等待重试", warning: true, statusDetail: "SuperGrok / X Search 暂时未响应，系统将在约 10 分钟后自动重试" };
    }
    return { health: "失败", warning: true, statusDetail: row.lastError };
  }
  if (row.latestRunStatus === "failed") {
    const message = row.latestRunErrorMessage ?? "最近一次采集失败";
    if (/401|403|auth|unauthorized|forbidden/i.test(message)) {
      return { health: "需要授权", warning: true, statusDetail: "检查平台密钥或 WeRSS 扫码授权" };
    }
    if (/^WERSS_FEED_(?:STALE|NEVER_SYNCED)/.test(message)) {
      return {
        health: "公众号源停更",
        warning: true,
        statusDetail: "WeRSS 长时间没有同步该公众号；系统已保留任务并等待上游恢复",
      };
    }
    return { health: "失败", warning: true, statusDetail: message };
  }
  if (row.lastSuccessAt) {
    const fetched = Number(row.latestRunFetchedCount ?? 0);
    const summary = summaryDetail(row);
    if (itemCount > 0) {
      return {
        health: fetched === 0 ? "暂无新内容" : "正常",
        warning: false,
        statusDetail: appendStatusDetail(`已采集 ${itemCount} 条`, summary),
      };
    }
    return {
      health: "首次无内容",
      warning: true,
      statusDetail: appendStatusDetail("已运行但没有入库内容，请检查外部订阅源", summary),
    };
  }
  return { health: healthLabel[row.healthStatus ?? "pending"] ?? "待运行", warning: true };
}

function summaryDetail(row: {
  latestSummaryStatus?: string | null;
  latestSummaryAttemptedCount?: number | null;
  latestSummarySucceededCount?: number | null;
  latestSummaryErrorCode?: string | null;
}): string | undefined {
  const status = row.latestSummaryStatus;
  const attempted = Number(row.latestSummaryAttemptedCount ?? 0);
  const succeeded = Number(row.latestSummarySucceededCount ?? 0);
  if (!status || status === "disabled" || status === "not_applicable" || attempted === 0) return undefined;
  if (status === "success") return `已摘要 ${succeeded} 条`;
  if (status === "partial") return `摘要 ${succeeded}/${attempted} 条`;
  if (status === "rate_limited") return "摘要限流";
  if (row.latestSummaryErrorCode === "SUMMARY_AUTH_REQUIRED") return "摘要需授权";
  if (row.latestSummaryErrorCode === "SUMMARY_CONFIG_REQUIRED") return "摘要配置不完整";
  if (row.latestSummaryErrorCode === "SUMMARY_TIMEOUT") return "摘要超时";
  return "摘要失败";
}

function appendStatusDetail(primary: string | undefined, secondary: string | undefined): string | undefined {
  if (!primary) return secondary;
  if (!secondary) return primary;
  return `${primary} · ${secondary}`;
}

export function formatReaderTime(date: Date): string {
  // 日期已经由分组标题承载；单条记录只显示时分，避免重复显示月日。
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  });
}

function looksLikeUsefulExcerpt(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  if (compact.length < 16) return false;
  if (/青年大学习|这下爽了|屠龙少年回来了|信息不足|暂无法形成可靠摘要|加我|进群|联系方式|开源知识库|全免费|请.*收藏|请.*转发|胆小请勿参赛/.test(compact)) return false;
  if (/要\s*1\s*[-到至]\s*2\s*句|不要复述标题|content_type|topic_tags|^\s*\{/.test(text)) return false;
  return true;
}

function displayExcerpt(row: {
  platform: PlatformType;
  bodyText: string;
  aiSummary?: string | null;
}): string {
  const summary = normalizeSummaryForDisplay(row.aiSummary);
  if (summary && looksLikeUsefulExcerpt(summary)) return summary;

  const sourceText = row.bodyText.trim();
  if (row.platform === "wechat") {
    return looksLikeUsefulExcerpt(sourceText) ? sourceText : "";
  }
  return looksLikeUsefulExcerpt(sourceText) ? sourceText : "";
}

function itemStatusBadge(row: {
  platform: PlatformType;
  bodyText: string;
  aiSummary?: string | null;
  contentHtml?: string | null;
  contentProvider?: string | null;
  contentFetchStatus?: string | null;
}): ReaderItem["statusBadge"] {
  const normalizedSummary = normalizeSummaryForDisplay(row.aiSummary);
  const hasUsefulSummary = Boolean(normalizedSummary && looksLikeUsefulExcerpt(normalizedSummary));
  // X reuses contentHtml as a JSON quote envelope; only WeChat treats it as full text.
  const hasFullText = row.platform === "wechat" && Boolean(row.contentHtml?.trim()) && !decodeXQuotedPost(row.contentHtml);

  if (row.platform === "wechat") {
    const usedFallback = row.contentProvider === "direct" || row.contentProvider === "wechat_download_api";
    if (hasFullText && hasUsefulSummary) {
      return {
        label: usedFallback ? "备用全文" : "全文摘要",
        tone: "ok",
        title: usedFallback
          ? "主通道未返回正文，备用通道已补回全文并生成摘要/标签"
          : "已获取公众号正文，并用模型生成摘要/标签",
      };
    }
    if (hasFullText) {
      return {
        label: usedFallback ? "备用全文" : "待摘要",
        tone: "warning",
        title: usedFallback
          ? "主通道未返回正文，备用通道已补回全文，等待模型摘要"
          : "已获取公众号正文，等待模型补充摘要/标签",
      };
    }
    if (row.contentFetchStatus === "failed") {
      return {
        label: "全文失败",
        tone: "warning",
        title: "本次已尝试配置的全文通道，但仍未获取正文；后续可在后台小批量补抓",
      };
    }
    return {
      label: "未抓全文",
      tone: "warning",
      title: "WeRSS 暂未返回公众号正文；当前只能展示标题或片段",
    };
  }

  if (!hasUsefulSummary) {
    return {
      label: "待AI处理",
      tone: "muted",
      title: "该内容还没有模型生成的中文标题/摘要/分类/标签",
    };
  }
  return undefined;
}

function mapRow(row: {
  id: string;
  platform: PlatformType;
  authorName: string | null;
  authorHandle: string | null;
  avatarUrl?: string | null;
  title: string | null;
  translatedTitle?: string | null;
  bodyText: string;
  aiSummary?: string | null;
  contentType?: string | null;
  topicTags?: string[] | null;
  retentionReason?: string | null;
  relevanceScore?: number | null;
  retentionSource?: string | null;
  contentHtml?: string | null;
  contentProvider?: string | null;
  contentFetchStatus?: string | null;
  contentFetchError?: string | null;
  contentFetchedAt?: Date | string | null;
  canonicalUrl: string;
  publishedAt: Date | string;
  matchReason?: string | null;
  bookmarked?: boolean;
}): ReaderItem {
  const fallbackContentType = deriveContentTypeId(row);
  const contentType = normalizeContentType(row.contentType) ?? fallbackContentType;
  const tags = normalizeTopicTags(row.topicTags, deriveTopicTags(row));
  const hasModelRetention = row.retentionSource === "model";
  const retention = deriveRetentionDecision({
    item: {
      platform: row.platform,
      upstreamId: row.id,
      canonicalUrl: row.canonicalUrl,
      authorName: row.authorName ?? undefined,
      authorHandle: row.authorHandle ?? undefined,
      title: row.title ?? undefined,
      text: row.bodyText,
      contentHtml: row.contentHtml ?? undefined,
      imageUrls: [],
      publishedAt: new Date(row.publishedAt),
      raw: {},
    },
    contentType,
    topicTags: tags,
    summary: row.aiSummary ?? undefined,
    modelReason: hasModelRetention ? row.retentionReason : undefined,
    modelScore: hasModelRetention ? row.relevanceScore : undefined,
  });
  const quoted = row.platform === "x" ? decodeXQuotedPost(row.contentHtml) : undefined;
  const quote = quoted
    ? {
        author: quoted.authorName || (quoted.authorHandle ? `@${quoted.authorHandle}` : "引用推文"),
        handle: quoted.authorHandle,
        text: quoted.text,
        url: quoted.url,
      }
    : undefined;

  return {
    id: row.id,
    platform: row.platform,
    source: row.authorName ?? row.authorHandle ?? (row.platform === "web_search" ? sourceNameFromUrl(row.canonicalUrl) : undefined) ?? "未知来源",
    handle: row.authorHandle ?? undefined,
    avatarUrl: row.avatarUrl ?? undefined,
    sourceKind:
      row.platform === "trendradar"
        ? trendRadarSourceKind(row.authorName, row.authorHandle)
        : row.platform === "x"
          ? "x"
          : row.platform === "wechat"
            ? "wechat"
            : "web",
    statusBadge: itemStatusBadge(row),
    time: formatReaderTime(new Date(row.publishedAt)),
    date: row.publishedAt instanceof Date ? row.publishedAt.toISOString() : String(row.publishedAt),
    title: readerDisplayTitle(row),
    // 优先用 AI 阅读全文后生成的摘要；原始引子过短/跑偏时不再冒充摘要。
    excerpt: displayExcerpt(row),
    url: row.canonicalUrl ?? undefined,
    quote,
    contentType,
    contentTypeLabel: getContentTypeLabel(contentType) ?? "观点解读",
    tags,
    score: retention.relevanceScore,
    // 规则回退仍用于后台筛选和评分，但不伪装成面向读者的推荐文案。
    // 前台仅展示模型基于具体内容生成的客观推荐理由。
    whyKept: readerRecommendationReason({ reason: row.retentionReason, source: row.retentionSource }),
    match: row.matchReason ?? "",
    bookmarked: Boolean(row.bookmarked),
  };
}

export function rowPassesSourceQuality(row: {
  platform: PlatformType;
  authorName?: string | null;
  title: string | null;
  bodyText: string;
}): boolean {
  if (row.platform !== "trendradar") return true;
  // Same gate as TrendRadar ingest + model backfill — no "DB-only" rows.
  return passesTrendRadarReaderGate({
    title: row.title,
    text: row.bodyText,
    authorName: row.authorName,
  });
}

function demoToReader(): ReaderItem[] {
  return demoItems.map((d) => ({
    id: d.id,
    platform: d.platform,
    source: d.source,
    handle: d.handle,
    sourceKind: d.platform === "x" ? "x" : d.platform === "wechat" ? "wechat" : "web",
    time: d.time,
    date: new Date().toISOString(),
    title: d.title,
    excerpt: d.excerpt,
    url: (d as { url?: string }).url,
    tags: d.tags,
    contentType: "opinion",
    contentTypeLabel: "观点解读",
    score: d.score,
    whyKept: d.match,
    match: d.match,
    bookmarked: false,
  }));
}

export async function loadBookmarkedFeed(): Promise<{ items: ReaderItem[]; total: number; usingDemo: boolean }> {
  if (!process.env.DATABASE_URL) return { items: [], total: 0, usingDemo: true };
  try {
    const total = await countItems({ bookmarkedOnly: true });
    const rows = await getItems({ bookmarkedOnly: true, limit: 200 });
    return { items: rows.map(mapRow), total, usingDemo: false };
  } catch (error) {
    readerLog.warn("reader.bookmarks.load_failed", { error });
    return { items: [], total: 0, usingDemo: true };
  }
}

function demoAdminMonitors(): AdminMonitorView[] {
  return demoMonitors.map((m, i) => ({
    id: `demo-${i}`,
    platform: m.platform,
    title: m.title,
    detail: m.detail,
    health: m.health,
    warning: m.warning,
    config: {},
    pollIntervalMinutes: 30,
  }));
}

function timestampOf(row: { publishedAt: Date | string }): number {
  return row.publishedAt instanceof Date ? row.publishedAt.getTime() : new Date(row.publishedAt).getTime();
}

export function capRowsPerPlatformForUnifiedFeed<T extends { id: string; platform: PlatformType; publishedAt: Date | string }>(
  rows: T[],
  perPlatformLimit = UNIFIED_FEED_PLATFORM_LIMIT,
): T[] {
  const balanced = READER_PLATFORMS.flatMap((platform) =>
    rows
      .filter((row) => row.platform === platform)
      .sort((a, b) => timestampOf(b) - timestampOf(a))
      .slice(0, perPlatformLimit),
  ).sort((a, b) => timestampOf(b) - timestampOf(a));
  const seen = new Set<string>();
  return balanced.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}

/**
 * Load the reader feed from Postgres. When DATABASE_URL is unset or the query
 * fails (e.g. local dev without a running DB), fall back to demo data so the
 * UI is never blank. `usingDemo` lets the page show a notice.
 */
export async function loadReaderFeed(filter: {
  platform?: PlatformType;
  search?: string;
  monitorId?: string;
  contentType?: string;
  topic?: string;
  since?: Date;
  page?: number;
  mode?: "featured" | "latest" | "archive";
} = {}): Promise<ReaderFeedResult> {
  const page = normalizeReaderPage(filter.page);
  if (!process.env.DATABASE_URL) {
    let items = demoToReader();
    const selectedType = getContentTypeFilter(filter.contentType);
    if (selectedType) items = items.filter((item) => item.contentType === selectedType.id);
    const selectedTopic = normalizeTopicLabel(filter.topic);
    if (selectedTopic) {
      items = items.filter((item) => item.tags.some((tag) => tag.toLocaleLowerCase() === selectedTopic.toLocaleLowerCase()));
    }
    if (filter.mode === "featured") items = buildFeaturedFeed(items, { balancePlatforms: !filter.platform });
    const total = items.length;
    const start = (page - 1) * READER_PAGE_SIZE;
    return feedResult({ items: items.slice(start, start + READER_PAGE_SIZE), usingDemo: true, total, page });
  }
  try {
    const { contentType, topic } = filter;
    const dbFilter = {
      platform: filter.platform,
      search: filter.search,
      monitorId: filter.monitorId,
      since: filter.since,
    };
    // Some reader filters are applied locally after the DB query:
    // - content type / topic can fall back to rule-based classification for old rows;
    // - TrendRadar/RSS source quality is intentionally applied in-process because
    //   the interest rules are user-editable.
    //
    // Therefore the DB window must be wider than the final page size. Otherwise
    // "全部" can accidentally show fewer rows than a specific content type when
    // the newest hotlist rows are filtered out as irrelevant.
    const needsLocalFilterWindow = Boolean(contentType || topic || dbFilter.platform === "trendradar");

    if (filter.mode === "featured") {
      const platforms = dbFilter.platform ? [dbFilter.platform] : READER_PLATFORMS;
      const platformCounts = await Promise.all(platforms.map((platform) => countItems({ ...dbFilter, platform })));
      const rows = (
        await Promise.all(platforms.map((platform, index) =>
          getItems({
            ...dbFilter,
            platform,
            limit: Math.min(Math.max(platformCounts[index], DEFAULT_PLATFORM_WINDOW), MAX_LOCAL_FILTER_SCAN),
          }),
        ))
      ).flat();
      const filteredRows = capRowsPerPlatformForUnifiedFeed(rows, Number.MAX_SAFE_INTEGER).filter((row) =>
        rowPassesSourceQuality(row) && itemMatchesContentType(row, contentType) && itemMatchesTopic(row, topic),
      );
      const featuredItems = buildFeaturedFeed(filteredRows.map(mapRow), {
        balancePlatforms: !dbFilter.platform,
      });
      return feedResult({
        items: featuredItems,
        usingDemo: false,
        total: featuredItems.length,
        page: 1,
        balancedOverview: true,
      });
    }

    if (dbFilter.platform) {
      const baseTotal = await countItems(dbFilter);
      if (!needsLocalFilterWindow) {
        const rows = await getItems({
          ...dbFilter,
          limit: READER_PAGE_SIZE,
          offset: (page - 1) * READER_PAGE_SIZE,
        });
        return feedResult({ items: rows.map(mapRow), usingDemo: false, total: baseTotal, page });
      }

      // Reader-only rules (editable TrendRadar interests and legacy rule-based
      // classification) cannot be represented safely as one fixed SQL clause.
      // Scan the complete current personal library up to a generous guardrail,
      // then paginate the visible rows. The UI marks totals as approximate only
      // once a library grows beyond that guardrail.
      const scanLimit = Math.min(Math.max(baseTotal, LOCAL_FILTER_WINDOW), MAX_LOCAL_FILTER_SCAN);
      const rows = await getItems({ ...dbFilter, limit: scanLimit });
      const filteredRows = rows.filter((row) =>
        rowPassesSourceQuality(row) && itemMatchesContentType(row, contentType) && itemMatchesTopic(row, topic),
      );
      const start = (page - 1) * READER_PAGE_SIZE;
      return feedResult({
        items: filteredRows.slice(start, start + READER_PAGE_SIZE).map(mapRow),
        usingDemo: false,
        total: filteredRows.length,
        totalIsExact: baseTotal <= MAX_LOCAL_FILTER_SCAN,
        page,
      });
    }

    // The cross-platform view is an intentionally balanced overview rather
    // than a chronological archive: high-volume hotlists must not drown out
    // WeChat and web-search results. Full paginated history is available in
    // each platform tab.
    const [platformCounts, documentTotal] = await Promise.all([
      Promise.all(READER_PLATFORMS.map((platform) => countItems({ ...dbFilter, platform }))),
      countItems(dbFilter),
    ]);
    const rows = (
      await Promise.all(
        READER_PLATFORMS.map((platform, index) => {
          const localRules = Boolean(contentType || topic || platform === "trendradar");
          const limit = localRules
            ? Math.min(Math.max(platformCounts[index], LOCAL_FILTER_WINDOW), MAX_LOCAL_FILTER_SCAN)
            : DEFAULT_PLATFORM_WINDOW;
          return getItems({ ...dbFilter, platform, limit });
        }),
      )
    ).flat();
    const filteredRows = capRowsPerPlatformForUnifiedFeed(rows, Number.MAX_SAFE_INTEGER).filter((row) =>
      rowPassesSourceQuality(row) && itemMatchesContentType(row, contentType) && itemMatchesTopic(row, topic),
    );
    const visibleRows = capRowsPerPlatformForUnifiedFeed(filteredRows);
    const hasLocalFilter = Boolean(contentType || topic);
    return feedResult({
      items: visibleRows.slice(0, READER_PAGE_SIZE).map(mapRow),
      usingDemo: false,
      total: hasLocalFilter ? filteredRows.length : documentTotal,
      totalIsExact: hasLocalFilter ? platformCounts.every((value) => value <= MAX_LOCAL_FILTER_SCAN) : true,
      page: 1,
      balancedOverview: true,
    });
  } catch (err) {
    readerLog.warn("reader.feed.demo_fallback", { error: err });
    let items = demoToReader();
    const selectedType = getContentTypeFilter(filter.contentType);
    if (selectedType) items = items.filter((item) => item.contentType === selectedType.id);
    const selectedTopic = normalizeTopicLabel(filter.topic);
    if (selectedTopic) {
      items = items.filter((item) => item.tags.some((tag) => tag.toLocaleLowerCase() === selectedTopic.toLocaleLowerCase()));
    }
    if (filter.mode === "featured") items = buildFeaturedFeed(items, { balancePlatforms: !filter.platform });
    const total = items.length;
    const start = (page - 1) * READER_PAGE_SIZE;
    return feedResult({ items: items.slice(start, start + READER_PAGE_SIZE), usingDemo: true, total, page });
  }
}

export async function loadWechatKeywordRuleFilters(): Promise<ReaderKeywordRuleFilter[]> {
  if (!process.env.DATABASE_URL) return [];
  try {
    return (await getWechatKeywordRuleFilters()).map((row) => ({
      id: row.id,
      name: row.name,
      itemCount: Number(row.itemCount ?? 0),
    }));
  } catch (err) {
    readerLog.warn("reader.keyword_filters.load_failed", { error: err });
    return [];
  }
}

export async function loadAdminMonitors(): Promise<{
  monitors: AdminMonitorView[];
  usingDemo: boolean;
}> {
  if (!process.env.DATABASE_URL) return { monitors: demoAdminMonitors(), usingDemo: true };
  try {
    const rows = await getMonitorsWithHealth();
    const monitors = rows.map((r) => {
      const health = deriveMonitorHealth(r);
      return {
        id: r.id,
        platform: r.platform,
        title: r.name,
        detail: monitorDetail(r.platform, r.pollIntervalMinutes, (r.config ?? {}) as Record<string, unknown>),
        health: health.health,
        warning: health.warning,
        statusDetail: health.statusDetail,
        config: (r.config ?? {}) as Record<string, unknown>,
        pollIntervalMinutes: r.pollIntervalMinutes,
      };
    });
    return { monitors, usingDemo: false };
  } catch (err) {
    readerLog.warn("reader.monitors.demo_fallback", { error: err });
    return { monitors: demoAdminMonitors(), usingDemo: true };
  }
}

export async function loadAdminCredentialStatus(): Promise<AdminCredentialStatus> {
  const fallback = {
    x: Boolean(process.env.X_BEARER_TOKEN?.trim()),
    wechat: Boolean(process.env.WERSS_ACCESS_KEY?.trim()),
    web_search_brave: Boolean(process.env.BRAVE_SEARCH_API_KEY?.trim()),
    web_search_tavily: Boolean(process.env.TAVILY_API_KEY?.trim()),
    web_search_serper: Boolean(process.env.SERPER_API_KEY?.trim()),
    model_api: Boolean(process.env.SUMMARY_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || process.env.DEEPSEEK_API_KEY?.trim() || process.env.ARK_API_KEY?.trim() || process.env.VOLCENGINE_API_KEY?.trim() || process.env.ANTHROPIC_API_KEY?.trim()),
  };
  const withAny = (status: Omit<AdminCredentialStatus, "web_search">): AdminCredentialStatus => ({
    ...status,
    web_search: status.web_search_brave || status.web_search_tavily || status.web_search_serper,
  });
  if (!process.env.DATABASE_URL) return withAny(fallback);
  try {
    const rows = await loadApiCredentials();
    const values = new Map(rows.map((row) => [row.key, row.value]));
    return withAny({
      x: Boolean(values.get("X_BEARER_TOKEN")?.trim() || fallback.x),
      wechat: Boolean(values.get("WERSS_ACCESS_KEY")?.trim() || fallback.wechat),
      web_search_brave: Boolean(values.get("BRAVE_SEARCH_API_KEY")?.trim() || fallback.web_search_brave),
      web_search_tavily: Boolean(values.get("TAVILY_API_KEY")?.trim() || fallback.web_search_tavily),
      web_search_serper: Boolean(values.get("SERPER_API_KEY")?.trim() || fallback.web_search_serper),
      model_api: Boolean(values.get("SUMMARY_API_KEY")?.trim() || fallback.model_api),
    });
  } catch {
    return withAny(fallback);
  }
}
