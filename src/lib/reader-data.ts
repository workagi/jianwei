import { getItems, getMonitorsWithHealth, getWechatKeywordRuleFilters, loadApiCredentials } from "@/db/queries";
import { demoItems, demoMonitors } from "./demo-data";
import type { PlatformType } from "@/connectors/types";
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
import { isTrendRadarInteresting } from "@/lib/trendradar-interest-filter";

const READER_PLATFORMS: PlatformType[] = ["x", "wechat", "web_search", "trendradar"];
const UNIFIED_FEED_PLATFORM_LIMIT = 18;

/**
 * Reader-facing item shape. Produced by both the live DB path and the demo
 * fallback so the UI components never branch on the data source.
 */
export interface ReaderItem {
  id: string;
  platform: PlatformType;
  source: string;
  handle?: string;
  time: string;
  date: string;
  title: string;
  excerpt: string;
  url?: string;
  contentType: string;
  contentTypeLabel: string;
  tags: string[];
  score: number;
  match: string;
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
  const cadence = `每 ${pollIntervalMinutes} 分钟`;
  if (platform === "trendradar") return `系统内置 · ${cadence}`;
  if (platform === "web_search") return `${webSearchProviderLabel(config)} · ${cadence}`;
  if (platform === "wechat" && config.kind === "keyword_rule") return `公众号关键词 · ${cadence}`;
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
    return { health: "失败", warning: true, statusDetail: row.lastError };
  }
  if (row.latestRunStatus === "failed") {
    const message = row.latestRunErrorMessage ?? "最近一次采集失败";
    if (/401|403|auth|unauthorized|forbidden/i.test(message)) {
      return { health: "需要授权", warning: true, statusDetail: "检查平台密钥或 WeRSS 扫码授权" };
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

function formatTime(date: Date): string {
  // 显式指定 Asia/Shanghai，避免容器/服务端时区为 UTC 时整体偏移 8 小时。
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  });
}

function mapRow(row: {
  id: string;
  platform: PlatformType;
  authorName: string | null;
  authorHandle: string | null;
  title: string | null;
  bodyText: string;
  aiSummary?: string | null;
  contentType?: string | null;
  topicTags?: string[] | null;
  canonicalUrl: string;
  publishedAt: Date | string;
  matchReason?: string | null;
}): ReaderItem {
  const fallbackContentType = deriveContentTypeId(row);
  const contentType = normalizeContentType(row.contentType) ?? fallbackContentType;
  const tags = normalizeTopicTags(row.topicTags, deriveTopicTags(row));
  return {
    id: row.id,
    platform: row.platform,
    source: row.authorName ?? row.authorHandle ?? (row.platform === "web_search" ? sourceNameFromUrl(row.canonicalUrl) : undefined) ?? "未知来源",
    handle: row.authorHandle ?? undefined,
    time: formatTime(new Date(row.publishedAt)),
    date: row.publishedAt instanceof Date ? row.publishedAt.toISOString() : String(row.publishedAt),
    title: row.title ?? "(无标题)",
    // 优先用 AI 阅读全文后生成的摘要，没有时回退到文章自带引子
    excerpt: row.aiSummary?.trim() ? row.aiSummary : row.bodyText,
    url: row.canonicalUrl ?? undefined,
    contentType,
    contentTypeLabel: getContentTypeLabel(contentType) ?? "观点解读",
    tags,
    score: 0,
    match: row.matchReason ?? "",
  };
}

function rowPassesSourceQuality(row: {
  platform: PlatformType;
  title: string | null;
  bodyText: string;
}): boolean {
  if (row.platform !== "trendradar") return true;
  return isTrendRadarInteresting({
    title: row.title ?? undefined,
    text: row.bodyText,
  });
}

function demoToReader(): ReaderItem[] {
  return demoItems.map((d) => ({
    id: d.id,
    platform: d.platform,
    source: d.source,
    handle: d.handle,
    time: d.time,
    date: new Date().toISOString(),
    title: d.title,
    excerpt: d.excerpt,
    url: (d as { url?: string }).url,
    tags: d.tags,
    contentType: "opinion",
    contentTypeLabel: "观点解读",
    score: d.score,
    match: d.match,
  }));
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

export function capRowsPerPlatformForUnifiedFeed<T extends { platform: PlatformType; publishedAt: Date | string }>(
  rows: T[],
  perPlatformLimit = UNIFIED_FEED_PLATFORM_LIMIT,
): T[] {
  return READER_PLATFORMS.flatMap((platform) =>
    rows
      .filter((row) => row.platform === platform)
      .sort((a, b) => timestampOf(b) - timestampOf(a))
      .slice(0, perPlatformLimit),
  ).sort((a, b) => timestampOf(b) - timestampOf(a));
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
} = {}): Promise<{ items: ReaderItem[]; usingDemo: boolean }> {
  if (!process.env.DATABASE_URL) {
    let items = demoToReader();
    const selectedType = getContentTypeFilter(filter.contentType);
    if (selectedType) items = items.filter((item) => item.contentType === selectedType.id);
    const selectedTopic = normalizeTopicLabel(filter.topic);
    if (selectedTopic) {
      items = items.filter((item) => item.tags.some((tag) => tag.toLocaleLowerCase() === selectedTopic.toLocaleLowerCase()));
    }
    return { items, usingDemo: true };
  }
  try {
    const { contentType, topic, ...dbFilter } = filter;
    const queryLimit = contentType || topic ? 200 : undefined;
    const rows = dbFilter.platform
      ? await getItems({
          ...dbFilter,
          // Content/topic filtering may fall back to local classification for old
          // rows whose persisted columns are still empty, so pull a slightly
          // wider recent window to avoid a sparse first page.
          limit: queryLimit,
        })
      : (
          await Promise.all(
            READER_PLATFORMS.map((platform) =>
              getItems({
                ...dbFilter,
                platform,
                // The unified feed is intentionally platform-balanced. Hotlist/RSS
                // can generate hundreds of fresh rows per day; reading a window per
                // platform prevents it from drowning out WeChat/X/web-search items.
                limit: queryLimit ?? 80,
              }),
            ),
          )
        ).flat();
    const filteredRows = rows.filter((row) =>
      rowPassesSourceQuality(row) && itemMatchesContentType(row, contentType) && itemMatchesTopic(row, topic),
    );
    const visibleRows = dbFilter.platform ? filteredRows : capRowsPerPlatformForUnifiedFeed(filteredRows);
    return { items: visibleRows.slice(0, 50).map(mapRow), usingDemo: false };
  } catch (err) {
    console.warn("[reader-data] 数据库不可用，回退到演示数据:", (err as Error).message);
    let items = demoToReader();
    const selectedType = getContentTypeFilter(filter.contentType);
    if (selectedType) items = items.filter((item) => item.contentType === selectedType.id);
    const selectedTopic = normalizeTopicLabel(filter.topic);
    if (selectedTopic) {
      items = items.filter((item) => item.tags.some((tag) => tag.toLocaleLowerCase() === selectedTopic.toLocaleLowerCase()));
    }
    return { items, usingDemo: true };
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
    console.warn("[reader-data] 关键词规则筛选加载失败:", (err as Error).message);
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
    console.warn("[reader-data] 监控列表回退演示数据:", (err as Error).message);
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
