import type { CollectionResult, Connector, NormalizedItem, XMonitorConfig } from "@/connectors/types";
import { xMonitorSchema } from "@/connectors/types";

interface XUser { id: string; name: string; username: string; profile_image_url?: string; }
interface XPost { id: string; text: string; created_at?: string; author_id?: string; }
interface XResponse<T> { data?: T; meta?: { newest_id?: string }; errors?: Array<{ detail?: string; title?: string }>; }

export class XConnector implements Connector<"x"> {
  constructor(private readonly bearerToken: string, private readonly fetcher: typeof fetch = fetch) {}

  private async request<T>(path: string, params: Record<string, string> = {}): Promise<XResponse<T>> {
    const url = new URL(`https://api.x.com/2/${path}`);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    const response = await this.fetcher(url, {
      headers: { Authorization: `Bearer ${this.bearerToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`X_API_${response.status}`);
    return response.json() as Promise<XResponse<T>>;
  }

  private async resolveUser(username: string): Promise<XUser> {
    const response = await this.request<XUser>(`users/by/username/${encodeURIComponent(username)}`, {
      "user.fields": "id,name,username,profile_image_url,protected",
    });
    if (!response.data) throw new Error(response.errors?.[0]?.detail ?? "X_USER_NOT_FOUND");
    return response.data;
  }

  private normalize(post: XPost, user: XUser): NormalizedItem {
    return {
      platform: "x",
      upstreamId: post.id,
      canonicalUrl: `https://x.com/${user.username}/status/${post.id}`,
      authorId: user.id,
      authorName: user.name,
      authorHandle: user.username,
      text: post.text,
      imageUrls: [],
      publishedAt: post.created_at ? new Date(post.created_at) : new Date(),
      raw: post,
    };
  }

  private async timeline(user: XUser, config: XMonitorConfig, maxResults: number, sinceId?: string) {
    const excludes = [!config.includeReplies && "replies", !config.includeReposts && "retweets"].filter(Boolean).join(",");
    const params: Record<string, string> = {
      max_results: String(Math.max(5, maxResults)),
      "tweet.fields": "id,text,created_at,author_id,attachments,entities,referenced_tweets",
    };
    if (excludes) params.exclude = excludes;
    if (sinceId) params.since_id = sinceId;
    return this.request<XPost[]>(`users/${user.id}/tweets`, params);
  }

  async validate(config: XMonitorConfig) {
    const parsed = xMonitorSchema.parse(config);
    const user = await this.resolveUser(parsed.username);
    const response = await this.timeline(user, parsed, 5);
    return {
      displayName: `${user.name} (@${user.username})`,
      avatarUrl: user.profile_image_url,
      items: (response.data ?? []).map((post) => this.normalize(post, user)),
    };
  }

  async collect(config: XMonitorConfig, cursor: Record<string, unknown>): Promise<CollectionResult> {
    const parsed = xMonitorSchema.parse(config);
    const user = await this.resolveUser(parsed.username);
    const response = await this.timeline(user, parsed, 100, typeof cursor.sinceId === "string" ? cursor.sinceId : undefined);
    const items = (response.data ?? []).map((post) => this.normalize(post, user));
    return {
      items,
      cursor: { userId: user.id, sinceId: response.meta?.newest_id ?? cursor.sinceId },
      billableUnits: items.length + 1,
    };
  }

  async health() {
    return { ok: Boolean(this.bearerToken), message: this.bearerToken ? undefined : "X_BEARER_TOKEN 未配置" };
  }
}
