import type { CollectContext, CollectionResult, Connector, NormalizedItem, XMonitorConfig, XQuotedPost } from "@/connectors/types";
import { encodeXQuotedPost, xMonitorSchema } from "@/connectors/types";
import { signalWithTimeout } from "@/lib/abort-signal";

interface XUser {
  id: string;
  name: string;
  username: string;
  profile_image_url?: string;
}
interface XPost {
  id: string;
  text: string;
  created_at?: string;
  author_id?: string;
  referenced_tweets?: Array<{ type?: string; id?: string }>;
}
interface XResponse<T> {
  data?: T;
  includes?: {
    tweets?: Array<{ id?: string; text?: string; author_id?: string }>;
    users?: Array<{ id?: string; name?: string; username?: string }>;
  };
  meta?: { newest_id?: string; next_token?: string };
  errors?: Array<{ detail?: string; title?: string }>;
}

export class XConnector implements Connector<"x"> {
  constructor(
    private readonly bearerToken: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async request<T>(
    path: string,
    params: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<XResponse<T>> {
    const url = new URL(`https://api.x.com/2/${path}`);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    const response = await this.fetcher(url, {
      headers: { Authorization: `Bearer ${this.bearerToken}` },
      signal: signalWithTimeout(signal, 10_000),
    });
    if (!response.ok) throw new Error(`X_API_${response.status}`);
    return response.json() as Promise<XResponse<T>>;
  }

  private async resolveUser(username: string, signal?: AbortSignal): Promise<XUser> {
    const response = await this.request<XUser>(`users/by/username/${encodeURIComponent(username)}`, {
      "user.fields": "id,name,username,profile_image_url,protected",
    }, signal);
    if (!response.data) throw new Error(response.errors?.[0]?.detail ?? "X_USER_NOT_FOUND");
    return response.data;
  }

  private postType(post: XPost): "original" | "reply" | "repost" | "quote" {
    const refs = post.referenced_tweets ?? [];
    if (refs.some((ref) => ref.type === "retweeted")) return "repost";
    if (refs.some((ref) => ref.type === "quoted")) return "quote";
    if (refs.some((ref) => ref.type === "replied_to")) return "reply";
    return "original";
  }

  private matchesScope(post: XPost, config: XMonitorConfig): boolean {
    const type = this.postType(post);
    if (type === "reply") return config.includeReplies;
    if (type === "repost") return config.includeReposts;
    if (type === "quote") return config.includeQuotes;
    return true;
  }

  private quotedPostFromIncludes(post: XPost, includes?: XResponse<XPost[]>["includes"]): XQuotedPost | undefined {
    const quotedId = post.referenced_tweets?.find((ref) => ref.type === "quoted")?.id;
    if (!quotedId) return undefined;
    const quoted = includes?.tweets?.find((tweet) => tweet.id === quotedId);
    if (!quoted?.text?.trim()) return undefined;
    const author = includes?.users?.find((user) => user.id === quoted.author_id);
    return {
      text: quoted.text.trim(),
      ...(author?.name ? { authorName: author.name } : {}),
      ...(author?.username ? { authorHandle: author.username } : {}),
      ...(author?.username
        ? { url: `https://x.com/${author.username}/status/${quotedId}` }
        : { url: `https://x.com/i/status/${quotedId}` }),
    };
  }

  private normalize(post: XPost, user: XUser, includes?: XResponse<XPost[]>["includes"]): NormalizedItem {
    const type = this.postType(post);
    const quotedPost = type === "quote" ? this.quotedPostFromIncludes(post, includes) : undefined;
    return {
      platform: "x",
      upstreamId: post.id,
      canonicalUrl: `https://x.com/${user.username}/status/${post.id}`,
      authorId: user.id,
      authorName: user.name,
      authorHandle: user.username,
      avatarUrl: user.profile_image_url,
      text: post.text,
      ...(quotedPost ? { quotedPost, contentHtml: encodeXQuotedPost(quotedPost) } : {}),
      imageUrls: [],
      publishedAt: post.created_at ? new Date(post.created_at) : new Date(),
      raw: { ...post, postType: type },
    };
  }

  private async timeline(
    user: XUser,
    config: XMonitorConfig,
    maxResults: number,
    sinceId?: string,
    paginationToken?: string,
    signal?: AbortSignal,
  ) {
    // Official API can exclude replies/retweets server-side, but not quote tweets.
    // Quotes are filtered client-side via matchesScope / includeQuotes.
    const excludes = [!config.includeReplies && "replies", !config.includeReposts && "retweets"]
      .filter(Boolean)
      .join(",");
    const params: Record<string, string> = {
      max_results: String(Math.max(5, maxResults)),
      "tweet.fields": "id,text,created_at,author_id,attachments,entities,referenced_tweets",
      expansions: "referenced_tweets.id,referenced_tweets.id.author_id",
      "user.fields": "id,name,username",
    };
    if (excludes) params.exclude = excludes;
    if (sinceId) params.since_id = sinceId;
    if (paginationToken) params.pagination_token = paginationToken;
    return this.request<XPost[]>(`users/${user.id}/tweets`, params, signal);
  }

  async validate(config: XMonitorConfig) {
    const parsed = xMonitorSchema.parse(config);
    const user = await this.resolveUser(parsed.username);
    const response = await this.timeline(user, parsed, 5);
    const items = (response.data ?? [])
      .filter((post) => this.matchesScope(post, parsed))
      .map((post) => this.normalize(post, user, response.includes));
    return {
      displayName: `${user.name} (@${user.username})`,
      avatarUrl: user.profile_image_url,
      items,
    };
  }

  async collect(config: XMonitorConfig, cursor: Record<string, unknown>, context?: CollectContext): Promise<CollectionResult> {
    const parsed = xMonitorSchema.parse(config);
    const user = await this.resolveUser(parsed.username, context?.signal);
    const sinceId = typeof cursor.sinceId === "string" ? cursor.sinceId : undefined;
    const configuredMaxPages = Number(process.env.X_API_MAX_PAGES ?? "20");
    const maxPages = Number.isFinite(configuredMaxPages)
      ? Math.min(100, Math.max(1, Math.floor(configuredMaxPages)))
      : 20;
    const items: NormalizedItem[] = [];
    const seenPaginationTokens = new Set<string>();
    const storedPaginationToken = typeof cursor.xPaginationToken === "string"
      ? cursor.xPaginationToken.trim() || undefined
      : undefined;
    const paginationSinceId = typeof cursor.xPaginationSinceId === "string"
      ? cursor.xPaginationSinceId
      : sinceId;
    let paginationToken = storedPaginationToken;
    let newestId = typeof cursor.xPaginationNewestId === "string"
      ? cursor.xPaginationNewestId
      : undefined;
    let billableUnits = 1; // user lookup
    if (paginationToken) seenPaginationTokens.add(paginationToken);

    for (let page = 0; page < maxPages; page += 1) {
      const response = await this.timeline(
        user,
        parsed,
        100,
        paginationSinceId,
        paginationToken,
        context?.signal,
      );
      if (!newestId) newestId = response.meta?.newest_id;
      billableUnits += response.data?.length ?? 0;
      items.push(
        ...(response.data ?? [])
          .filter((post) => this.matchesScope(post, parsed))
          .map((post) => this.normalize(post, user, response.includes)),
      );

      const nextToken = response.meta?.next_token?.trim();
      if (!nextToken) {
        paginationToken = undefined;
        break;
      }
      if (seenPaginationTokens.has(nextToken)) throw new Error("X_API_PAGINATION_LOOP");
      seenPaginationTokens.add(nextToken);
      paginationToken = nextToken;
    }

    // Page ceilings are normal backpressure, not a failed run. Commit the
    // pages already fetched and persist the opaque X pagination token. The
    // next poll resumes from that exact page; sinceId advances only after the
    // backlog is fully drained.
    const nextCursor = paginationToken
      ? {
          userId: user.id,
          profileName: user.name,
          sinceId,
          xPaginationToken: paginationToken,
          xPaginationSinceId: paginationSinceId,
          xPaginationNewestId: newestId,
        }
      : {
          userId: user.id,
          profileName: user.name,
          sinceId: newestId ?? sinceId,
        };
    return {
      items,
      cursor: nextCursor,
      // X charges for provider rows read, including quotes/replies later
      // removed by local scope filters. Count raw rows, not retained items.
      billableUnits,
    };
  }

  async health() {
    return { ok: Boolean(this.bearerToken), message: this.bearerToken ? undefined : "X_BEARER_TOKEN 未配置" };
  }
}
