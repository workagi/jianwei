import type { CollectContext, CollectionResult, Connector, NormalizedItem, WebSearchMonitorConfig } from "@/connectors/types";
import { webSearchMonitorSchema } from "@/connectors/types";
import { canonicalizeUrl } from "@/ingestion/deduplicate";
import { buildSearchQuery } from "./query-builder";
import { filterSearchItems } from "./result-filter";
import { sourceNameFromUrl } from "./source-name";
import { signalWithTimeout } from "@/lib/abort-signal";

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
  raw_content?: string | null;
  favicon?: string;
}

interface TavilyResponse {
  query?: string;
  results?: TavilyResult[];
  usage?: { credits?: number };
}

export class TavilyConnector implements Connector<"web_search"> {
  constructor(private readonly apiKey: string, private readonly fetcher: typeof fetch = fetch) {}

  private async search(config: WebSearchMonitorConfig, count = 10, signal?: AbortSignal): Promise<NormalizedItem[]> {
    const parsed = webSearchMonitorSchema.parse(config);
    if (!this.apiKey) throw new Error("TAVILY_API_KEY 未配置");
    const response = await this.fetcher("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      signal: signalWithTimeout(signal, 15_000),
      body: JSON.stringify({
        query: buildSearchQuery(parsed),
        search_depth: "basic",
        max_results: count,
        topic: parsed.resultType === "news" ? "news" : "general",
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        include_favicon: true,
      }),
    });
    if (!response.ok) throw new Error(`TAVILY_${response.status}: ${(await response.text()).slice(0, 200)}`);
    const data = (await response.json()) as TavilyResponse;
    const items: NormalizedItem[] = (data.results ?? [])
      .filter((row): row is TavilyResult & { url: string } => Boolean(row.url))
      .map((row) => ({
        platform: "web_search",
        upstreamId: canonicalizeUrl(row.url),
        canonicalUrl: canonicalizeUrl(row.url),
        authorName: sourceNameFromUrl(row.url),
        title: row.title,
        text: row.content ?? row.raw_content ?? "",
        imageUrls: [],
        publishedAt: new Date(),
        raw: row,
      }));
    return filterSearchItems(items, parsed).items;
  }

  async validate(config: WebSearchMonitorConfig) {
    const items = await this.search(config, 3);
    return { displayName: `${webSearchMonitorSchema.parse(config).query} · Tavily`, items };
  }

  async collect(config: WebSearchMonitorConfig, _cursor: Record<string, unknown>, context?: CollectContext): Promise<CollectionResult> {
    const items = await this.search(config, 20, context?.signal);
    return { items, cursor: { collectedAt: new Date().toISOString(), provider: "tavily" }, billableUnits: 1 };
  }

  async health() {
    return { ok: Boolean(this.apiKey), message: this.apiKey ? undefined : "TAVILY_API_KEY 未配置" };
  }
}
