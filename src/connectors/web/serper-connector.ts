import type { CollectionResult, Connector, NormalizedItem, WebSearchMonitorConfig } from "@/connectors/types";
import { webSearchMonitorSchema } from "@/connectors/types";
import { canonicalizeUrl } from "@/ingestion/deduplicate";
import { buildSearchQuery } from "./query-builder";
import { filterSearchItems } from "./result-filter";
import { cleanSourceName, sourceNameFromUrl } from "./source-name";

interface SerperResult {
  title?: string;
  link?: string;
  snippet?: string;
  date?: string;
  source?: string;
}

interface SerperResponse {
  organic?: SerperResult[];
  news?: SerperResult[];
}

export class SerperConnector implements Connector<"web_search"> {
  constructor(private readonly apiKey: string, private readonly fetcher: typeof fetch = fetch) {}

  private async search(config: WebSearchMonitorConfig, count = 10): Promise<NormalizedItem[]> {
    const parsed = webSearchMonitorSchema.parse(config);
    if (!this.apiKey) throw new Error("SERPER_API_KEY 未配置");
    const endpoint = parsed.resultType === "news" ? "news" : "search";
    const response = await this.fetcher(`https://google.serper.dev/${endpoint}`, {
      method: "POST",
      headers: {
        "X-API-KEY": this.apiKey,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        q: buildSearchQuery(parsed),
        num: count,
        ...(parsed.country ? { gl: parsed.country.toLowerCase() } : {}),
        ...(parsed.language ? { hl: parsed.language.toLowerCase() } : {}),
      }),
    });
    if (!response.ok) throw new Error(`SERPER_${response.status}: ${(await response.text()).slice(0, 200)}`);
    const data = (await response.json()) as SerperResponse;
    const rows = parsed.resultType === "news" ? data.news ?? [] : data.organic ?? [];
    const items: NormalizedItem[] = rows
      .filter((row): row is SerperResult & { link: string } => Boolean(row.link))
      .map((row) => ({
        platform: "web_search",
        upstreamId: canonicalizeUrl(row.link),
        canonicalUrl: canonicalizeUrl(row.link),
        authorName: cleanSourceName(row.source) ?? sourceNameFromUrl(row.link),
        title: row.title,
        text: row.snippet ?? "",
        imageUrls: [],
        publishedAt: row.date ? new Date(row.date) : new Date(),
        raw: row,
      }));
    return filterSearchItems(items, parsed).items;
  }

  async validate(config: WebSearchMonitorConfig) {
    const items = await this.search(config, 3);
    return { displayName: `${webSearchMonitorSchema.parse(config).query} · Serper`, items };
  }

  async collect(config: WebSearchMonitorConfig): Promise<CollectionResult> {
    const items = await this.search(config, 20);
    return { items, cursor: { collectedAt: new Date().toISOString(), provider: "serper" }, billableUnits: 1 };
  }

  async health() {
    return { ok: Boolean(this.apiKey), message: this.apiKey ? undefined : "SERPER_API_KEY 未配置" };
  }
}
