import type { NormalizedItem } from "@/connectors/types";
import { filterTrendRadarItems } from "@/lib/trendradar-interest-filter";
import { TrendRadarMcpClient } from "./mcp-client";

interface TrendRadarNewsRow {
  title: string;
  platform?: string;
  platform_name?: string;
  rank?: number;
  timestamp?: string;
  url?: string;
}

interface TrendRadarRssRow {
  title: string;
  feed_id?: string;
  feed_name?: string;
  url?: string;
  published_at?: string;
  author?: string;
  date?: string;
  fetch_time?: string;
  summary?: string;
}

interface TrendRadarToolResponse<T> {
  success: boolean;
  data?: T[];
}

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * TrendRadar hotlist timestamps are emitted as local China time strings such as
 * `2026-07-14 20:02:26` without a timezone suffix. Node parses that in the
 * container timezone (UTC in Docker), which shifts the reader eight hours into
 * the future. Treat timezone-less TrendRadar strings as Asia/Shanghai.
 */
function parseTrendRadarTime(value?: string): Date | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;

  // Strings with an explicit timezone are already absolute instants.
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }

  const match = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (match) {
    const [, y, mo, d, h = "00", mi = "00", s = "00"] = match;
    return new Date(
      Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) -
        SHANGHAI_OFFSET_MS,
    );
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Adapter that imports TrendRadar hotlist and RSS results into the shared
 * normalized item model. TrendRadar owns collection, filtering, scheduling and
 * AI analysis; 见微 only normalizes the output under a single platform so
 * the reader can deduplicate and display it alongside the direct connectors.
 */
export class TrendRadarConnector {
  constructor(private readonly client: TrendRadarMcpClient) {}

  /**
   * 真实 TrendRadar MCP 契约(已对照 wantcat/trendradar-mcp@mcp-v4.1.0 源码核实):
   * - get_latest_news(platforms, limit=50, include_url) 返回 {success, summary, data:[...]}
   *   每条 news 含 title/platform/platform_name/rank/timestamp,url 与 mobileUrl 仅在
   *   include_url=true 时返回 —— 不传就拿不到链接。
   * - get_latest_rss(feeds, days=1, limit=50, include_summary) 返回 {success, summary, data:[...]}
   *   每条 rss 含 title/feed_id/feed_name/url/published_at/author/date/fetch_time,
   *   summary 仅在 include_summary=true 时返回。第二个参数对应 days(最近 N 天)。
   */
  async latestNews(limit = 50, signal?: AbortSignal): Promise<NormalizedItem[]> {
    const result = await this.client.callTool<TrendRadarToolResponse<TrendRadarNewsRow>>(
      "get_latest_news",
      { limit, include_url: true },
      signal,
    );
    return filterTrendRadarItems((result.data ?? []).slice(0, limit).map((row) => this.normalizeNews(row)));
  }

  async latestRss(limit = 50, days = 1, signal?: AbortSignal): Promise<NormalizedItem[]> {
    const result = await this.client.callTool<TrendRadarToolResponse<TrendRadarRssRow>>(
      "get_latest_rss",
      { limit, days, include_summary: true },
      signal,
    );
    return filterTrendRadarItems((result.data ?? []).slice(0, limit).map((row) => this.normalizeRss(row)));
  }

  private normalizeNews(row: TrendRadarNewsRow): NormalizedItem {
    return {
      platform: "trendradar",
      upstreamId: row.url ?? `${row.platform ?? "news"}:${row.rank ?? ""}:${row.title}`,
      canonicalUrl: row.url ?? "",
      authorName: row.platform_name,
      authorHandle: row.platform,
      title: row.title,
      text: row.title,
      imageUrls: [],
      publishedAt: parseTrendRadarTime(row.timestamp) ?? new Date(),
      raw: row,
    };
  }

  private normalizeRss(row: TrendRadarRssRow): NormalizedItem {
    const publishedAt = row.published_at ?? row.date ?? row.fetch_time;
    return {
      platform: "trendradar",
      upstreamId: row.url ?? `${row.feed_id ?? "rss"}:${row.title}`,
      canonicalUrl: row.url ?? "",
      authorName: row.feed_name,
      authorHandle: row.author,
      title: row.title,
      text: row.summary ?? row.title,
      imageUrls: [],
      publishedAt: parseTrendRadarTime(publishedAt) ?? new Date(),
      raw: row,
    };
  }
}
