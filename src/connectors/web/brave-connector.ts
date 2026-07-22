import type { CollectContext, CollectionResult, Connector, NormalizedItem, WebSearchMonitorConfig } from "@/connectors/types";
import { webSearchMonitorSchema } from "@/connectors/types";
import { canonicalizeUrl } from "@/ingestion/deduplicate";
import { filterSearchItems } from "./result-filter";
import { buildSearchQuery } from "./query-builder";
import { cleanSourceName, sourceNameFromUrl } from "./source-name";
import { signalWithTimeout } from "@/lib/abort-signal";

interface BraveResult {
  title: string;
  url: string;
  description?: string;
  age?: string;
  page_age?: string;
  profile?: { name?: string; long_name?: string; url?: string };
  meta_url?: { hostname?: string };
}
interface BraveResponse { web?: { results?: BraveResult[] }; news?: { results?: BraveResult[] }; }
interface BraveNewsResponse { results?: BraveResult[]; }

function bravePublishedAt(row: BraveResult): Date {
  const value = row.page_age ?? row.age;
  if (value) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date();
}

export class BraveConnector implements Connector<"web_search"> {
  constructor(private readonly apiKey: string, private readonly fetcher: typeof fetch = fetch) {}

  private async search(config: WebSearchMonitorConfig, count = 10, signal?: AbortSignal): Promise<NormalizedItem[]> {
    const parsed = webSearchMonitorSchema.parse(config);
    if (!this.apiKey) throw new Error("BRAVE_SEARCH_API_KEY 未配置");
    const endpoint = parsed.resultType === "news"
      ? "https://api.search.brave.com/res/v1/news/search"
      : "https://api.search.brave.com/res/v1/web/search";
    const url = new URL(endpoint);
    url.searchParams.set("q", buildSearchQuery(parsed));
    url.searchParams.set("count", String(count));
    url.searchParams.set("freshness", "pw");
    if (parsed.country) url.searchParams.set("country", parsed.country);
    if (parsed.language) url.searchParams.set("search_lang", parsed.language);

    const response = await this.fetcher(url, {
      headers: { Accept: "application/json", "X-Subscription-Token": this.apiKey },
      signal: signalWithTimeout(signal, 10_000),
    });
    if (!response.ok) throw new Error(`BRAVE_${response.status}`);
    const data = await response.json() as BraveResponse | BraveNewsResponse;
    const rows = parsed.resultType === "news"
      ? ((data as BraveNewsResponse).results ?? [])
      : [
          ...((data as BraveResponse).web?.results ?? []),
          ...(parsed.resultType === "web" ? [] : ((data as BraveResponse).news?.results ?? [])),
        ];
    const items: NormalizedItem[] = rows.map((row) => ({
      platform: "web_search",
      upstreamId: canonicalizeUrl(row.url),
      canonicalUrl: canonicalizeUrl(row.url),
      authorName: cleanSourceName(row.profile?.name) ?? cleanSourceName(row.profile?.long_name) ?? cleanSourceName(row.meta_url?.hostname) ?? sourceNameFromUrl(row.url),
      title: row.title,
      text: row.description ?? "",
      imageUrls: [],
      publishedAt: bravePublishedAt(row),
      raw: row,
    }));
    return filterSearchItems(items, parsed).items;
  }

  async validate(config: WebSearchMonitorConfig) {
    const items = await this.search(config, 3);
    return { displayName: webSearchMonitorSchema.parse(config).query, items };
  }

  async collect(config: WebSearchMonitorConfig, _cursor: Record<string, unknown>, context?: CollectContext): Promise<CollectionResult> {
    const items = await this.search(config, 20, context?.signal);
    return { items, cursor: { collectedAt: new Date().toISOString() }, billableUnits: 1 };
  }

  async health() {
    return { ok: Boolean(this.apiKey), message: this.apiKey ? undefined : "BRAVE_SEARCH_API_KEY 未配置" };
  }
}
