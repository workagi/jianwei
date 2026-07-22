import type { CollectContext, CollectionResult, Connector, NormalizedItem, XMonitorConfig, XQuotedPost } from "@/connectors/types";
import { encodeXQuotedPost, xMonitorSchema } from "@/connectors/types";
import { abortableDelay, signalWithTimeout } from "@/lib/abort-signal";

type TokenResolver = () => Promise<string>;
type XaiPost = {
  url?: unknown;
  text?: unknown;
  published_at?: unknown;
  author_name?: unknown;
  post_type?: unknown;
  quoted_url?: unknown;
  quoted_text?: unknown;
  quoted_author_name?: unknown;
  quoted_author_handle?: unknown;
};

type XPostType = "original" | "reply" | "repost" | "quote";

const XAI_SEARCH_TIMEOUT_MS = 55_000;

function positiveInt(envName: string, fallback: number, max: number): number {
  const parsed = Number(process.env[envName]);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

/** Transient retries only. Default 2 keeps reliability without triple-burning SuperGrok quota. */
export function xaiSearchAttempts(): number {
  return positiveInt("XAI_X_SEARCH_ATTEMPTS", 2, 5);
}

/**
 * Max posts requested on a normal collect poll.
 * Preview stays small (5). Regular polls rarely need 25 — that just inflates
 * model/tool work for accounts that post a few times a day.
 */
export function xaiSearchMaxPosts(preview: boolean): number {
  if (preview) return 5;
  return positiveInt("XAI_X_SEARCH_MAX_POSTS", 10, 25);
}

/** When no cursor exists yet, how many days of X history to ask for. */
export function xaiSearchLookbackDays(): number {
  return positiveInt("XAI_X_SEARCH_LOOKBACK_DAYS", 2, 30);
}

/**
 * Model for SuperGrok X Search polls.
 * Retrieval + structured JSON does not need a heavy reasoning model; the old
 * default `grok-4.20-reasoning` is the main quota burner for this path.
 */
export function xaiSearchModel(): string {
  return process.env.XAI_X_SEARCH_MODEL?.trim() || "grok-4-1-fast-non-reasoning";
}

function transientFetchError(error: unknown): Error {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new Error("XAI_X_SEARCH_TIMEOUT");
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return new Error("XAI_X_SEARCH_TIMEOUT");
  }
  const cause = error && typeof error === "object" ? (error as { cause?: unknown }).cause : undefined;
  const code = cause && typeof cause === "object" && "code" in cause
    ? String((cause as { code?: unknown }).code ?? "")
    : "";
  return new Error(code ? `XAI_X_SEARCH_NETWORK:${code}` : "XAI_X_SEARCH_NETWORK");
}

function normalizePostType(value: unknown): XPostType | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "original" || normalized === "reply" || normalized === "repost" || normalized === "quote") {
    return normalized;
  }
  return undefined;
}

/**
 * X Search is an LLM-backed retrieval tool, so prompt instructions alone are
 * not an enforcement boundary. When a scope is disabled, require an explicit
 * structured type and reject anything uncertain before it reaches ingestion.
 *
 * Quote tweets are NOT treated as originals: they must be explicitly enabled
 * via includeQuotes (default false). Uncertain types only pass when every
 * expanded scope is enabled.
 */
export function xPostMatchesScope(post: XaiPost, config: XMonitorConfig): boolean {
  const postType = normalizePostType(post.post_type);
  if (!postType) {
    return Boolean(config.includeReplies && config.includeReposts && config.includeQuotes);
  }
  if (postType === "reply") return config.includeReplies;
  if (postType === "repost") return config.includeReposts;
  if (postType === "quote") return config.includeQuotes;
  return true;
}

function normalizeQuotedPost(post: XaiPost): XQuotedPost | undefined {
  if (typeof post.quoted_text !== "string" || !post.quoted_text.trim()) return undefined;
  const authorHandle =
    typeof post.quoted_author_handle === "string" && post.quoted_author_handle.trim()
      ? post.quoted_author_handle.trim().replace(/^@/, "")
      : undefined;
  const authorName =
    typeof post.quoted_author_name === "string" && post.quoted_author_name.trim()
      ? post.quoted_author_name.trim()
      : undefined;
  const url = typeof post.quoted_url === "string" && post.quoted_url.trim() ? post.quoted_url.trim() : undefined;
  return {
    text: post.quoted_text.trim(),
    ...(authorName ? { authorName } : {}),
    ...(authorHandle ? { authorHandle } : {}),
    ...(url ? { url } : {}),
  };
}

function responseText(data: Record<string, unknown>): string {
  if (typeof data.output_text === "string") return data.output_text;
  const output = Array.isArray(data.output) ? data.output : [];
  return output.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const content = Array.isArray((entry as { content?: unknown }).content) ? (entry as { content: unknown[] }).content : [];
    return content.flatMap((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : []);
  }).join("\n");
}

function citationUrls(data: Record<string, unknown>): Set<string> {
  const urls = new Set<string>();
  const visit = (value: unknown) => {
    if (typeof value === "string" && /^https?:\/\//.test(value)) urls.add(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.url === "string") urls.add(record.url);
      Object.entries(record).forEach(([key, child]) => {
        if (key === "citations" || key === "annotations" || key === "url" || key === "source" || key === "content" || key === "output") visit(child);
      });
    }
  };
  visit(data.citations);
  visit(data.output);
  return urls;
}

function safeXAvatarUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "pbs.twimg.com" && url.pathname.startsWith("/profile_images/")
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function jsonPosts(text: string): { profileName?: string; profileImageUrl?: string; posts: XaiPost[] } {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (!candidate) return { posts: [] };
  try {
    const parsed = JSON.parse(candidate) as { profile_name?: unknown; profile_image_url?: unknown; posts?: unknown };
    return {
      profileName: typeof parsed.profile_name === "string" ? parsed.profile_name : undefined,
      profileImageUrl: safeXAvatarUrl(parsed.profile_image_url),
      posts: Array.isArray(parsed.posts) ? parsed.posts.filter((post): post is XaiPost => Boolean(post && typeof post === "object")) : [],
    };
  } catch {
    return { posts: [] };
  }
}

/** xAI may prefer a readable numbered list even when JSON was requested. */
function markdownPosts(text: string): XaiPost[] {
  const blocks = text.split(/\*\*\d+\.\s*Exact post:\*\*/i).slice(1);
  return blocks.flatMap((block) => {
    const url = block.match(/\*\*URL:\*\*\s*(https?:\/\/[^\s]+)/i)?.[1];
    if (!url) return [];
    const postType = block.match(/\*\*Type:\*\*\s*(original|reply|repost|quote)/i)?.[1]?.toLowerCase();
    let content = block.slice(0, block.search(/\*\*URL:\*\*/i)).trim();
    content = content.replace(/\*\*Type:\*\*\s*(?:original|reply|repost|quote)\s*/i, "").trim();
    content = content.replace(/^\s*["“]/, "").replace(/["”]\s*$/, "").trim();
    return content ? [{ url, text: content, post_type: postType }] : [];
  });
}

function tweetIdentity(rawUrl: string, expectedHandle: string): { id: string; url: string } | null {
  try {
    const url = new URL(rawUrl);
    if (!(url.hostname === "x.com" || url.hostname === "twitter.com" || url.hostname.endsWith(".x.com"))) return null;
    const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)/i);
    if (!match || (match[1].toLowerCase() !== expectedHandle.toLowerCase() && match[1].toLowerCase() !== "i")) return null;
    return { id: match[2], url: `https://x.com/${expectedHandle}/status/${match[2]}` };
  } catch {
    return null;
  }
}

function tweetDate(id: string): Date | undefined {
  try {
    const timestamp = Number((BigInt(id) >> BigInt(22)) + BigInt("1288834974657"));
    if (Number.isFinite(timestamp) && timestamp > 0 && timestamp <= Date.now() + 60_000) return new Date(timestamp);
  } catch {}
  return undefined;
}

function normalizeDate(value: unknown, tweetId: string): Date {
  const parsed = typeof value === "string" ? new Date(value) : new Date();
  const now = Date.now();
  if (typeof value !== "string" || !Number.isFinite(parsed.getTime()) || parsed.getTime() > now + 60_000) {
    return tweetDate(tweetId) ?? new Date(now);
  }
  return parsed;
}

export class XaiSearchConnector implements Connector<"x"> {
  constructor(
    private readonly tokenResolver: TokenResolver,
    private readonly fetcher: typeof fetch = fetch,
    private readonly model = xaiSearchModel(),
  ) {}

  private async search(
    config: XMonitorConfig,
    cursor: Record<string, unknown>,
    preview: boolean,
    signal?: AbortSignal,
  ) {
    const token = await this.tokenResolver();
    const lookbackDays = xaiSearchLookbackDays();
    // Small overlap when resuming so posts near the previous boundary are not missed.
    const cursorFrom =
      typeof cursor.lastCollectedAt === "string" ? new Date(cursor.lastCollectedAt) : undefined;
    const from = cursorFrom && Number.isFinite(cursorFrom.getTime())
      ? new Date(cursorFrom.getTime() - 12 * 3_600_000)
      : new Date(Date.now() - lookbackDays * 86_400_000);
    const fromDate = Number.isFinite(from.getTime())
      ? from.toISOString().slice(0, 10)
      : new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 10);
    const toDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const maxPosts = xaiSearchMaxPosts(preview);
    const attempts = xaiSearchAttempts();
    const query = [
      `Find the newest public posts authored by @${config.username}.`,
      config.includeReplies ? "Include replies." : "Exclude replies when identifiable.",
      config.includeReposts ? "Include native reposts/retweets." : "Exclude native reposts/retweets when identifiable.",
      config.includeQuotes
        ? "Include quote tweets (posts that quote another post with the account's own commentary)."
        : "Exclude quote tweets entirely when identifiable. Do not classify quote tweets as original.",
      `Return at most ${maxPosts} posts.`,
      "Prefer posts newer than the previous collection window; do not pad with older posts just to fill the limit.",
      "For every result, classify the X post from its thread metadata as exactly one of: original, reply, repost, quote. Use original only for a top-level authored post with no quoted status, reply when it has a conversation parent, repost for a native repost/retweet without new commentary, and quote when the account added its own commentary while quoting another post. If the type cannot be verified, omit the post.",
      "If X Search exposes the account's current pbs.twimg.com/profile_images avatar URL, return it as profile_image_url; otherwise use an empty string.",
      config.includeQuotes
        ? "For quote posts, also return the quoted post fields when available: quoted_url, quoted_text (exact text of the quoted post), quoted_author_name, quoted_author_handle."
        : "Do not include quoted post fields.",
      "Return JSON only: {\"profile_name\":\"...\",\"profile_image_url\":\"https://pbs.twimg.com/profile_images/... or empty\",\"posts\":[{\"url\":\"https://x.com/handle/status/id\",\"text\":\"exact post text of the monitored account only\",\"published_at\":\"ISO-8601\",\"author_name\":\"...\",\"post_type\":\"original|reply|repost|quote\",\"quoted_url\":\"https://x.com/.../status/... or empty\",\"quoted_text\":\"exact quoted post text or empty\",\"quoted_author_name\":\"... or empty\",\"quoted_author_handle\":\"handle or empty\"}]}",
      "Never invent a post or URL. Omit any post that is not supported by an X Search citation.",
    ].join("\n");
    const body = JSON.stringify({
      model: this.model,
      input: [{ role: "user", content: query }],
      tools: [{ type: "x_search", allowed_x_handles: [config.username], from_date: fromDate, to_date: toDate }],
      store: false,
    });
    let response: Response | undefined;
    let lastFetchError: Error | undefined;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        response = await this.fetcher("https://api.x.ai/v1/responses", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body,
          signal: signalWithTimeout(signal, XAI_SEARCH_TIMEOUT_MS),
        });
        lastFetchError = undefined;
        const transient = response.status === 429 || response.status >= 500;
        if (response.ok || !transient || attempt === attempts - 1) break;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        lastFetchError = transientFetchError(error);
        if (attempt === attempts - 1 || lastFetchError.message === "XAI_X_SEARCH_TIMEOUT") break;
      }
      await abortableDelay(700 * (attempt + 1), signal);
    }
    if (lastFetchError) throw lastFetchError;
    if (!response) throw new Error("XAI_X_SEARCH_NO_RESPONSE");
    if (!response.ok) {
      if (response.status === 401) throw new Error("SUPERGROK_AUTH_EXPIRED");
      if (response.status === 403) throw new Error("SUPERGROK_X_SEARCH_NOT_ENTITLED");
      throw new Error(`XAI_X_SEARCH_${response.status}`);
    }
    const data = await response.json() as Record<string, unknown>;
    const citations = citationUrls(data);
    const answer = responseText(data);
    const parsed = jsonPosts(answer);
    const posts = parsed.posts.length > 0 ? parsed.posts : markdownPosts(answer);
    const citedIds = new Set([...citations].map((url) => tweetIdentity(url, config.username)?.id).filter(Boolean));
    const seen = new Set<string>();
    const items: NormalizedItem[] = [];
    for (const post of posts) {
      if (typeof post.url !== "string" || typeof post.text !== "string" || !post.text.trim()) continue;
      const identity = tweetIdentity(post.url, config.username);
      if (!identity || !citedIds.has(identity.id) || seen.has(identity.id)) continue;
      if (!xPostMatchesScope(post, config)) continue;
      seen.add(identity.id);
      const quotedPost =
        normalizePostType(post.post_type) === "quote" ? normalizeQuotedPost(post) : undefined;
      items.push({
        platform: "x",
        upstreamId: identity.id,
        canonicalUrl: identity.url,
        authorName: typeof post.author_name === "string" ? post.author_name : parsed.profileName,
        authorHandle: config.username,
        avatarUrl: parsed.profileImageUrl,
        text: post.text.trim(),
        ...(quotedPost ? { quotedPost, contentHtml: encodeXQuotedPost(quotedPost) } : {}),
        imageUrls: [],
        publishedAt: normalizeDate(post.published_at, identity.id),
        raw: { post, citations: [...citations], model: this.model, postType: normalizePostType(post.post_type) },
      });
    }
    return {
      items,
      profileName: parsed.profileName?.trim() || undefined,
      warning: items.length === 0 ? "xAI 没有返回可核验的推文引用，本次不入库，系统稍后会自动重试。" : undefined,
    };
  }

  async validate(config: XMonitorConfig) {
    const parsed = xMonitorSchema.parse(config);
    const result = await this.search(parsed, {}, true);
    return { displayName: result.profileName || `@${parsed.username}`, avatarUrl: result.items[0]?.avatarUrl, items: result.items, warning: result.warning };
  }

  async collect(config: XMonitorConfig, cursor: Record<string, unknown>, context?: CollectContext): Promise<CollectionResult> {
    const parsed = xMonitorSchema.parse(config);
    const result = await this.search(parsed, cursor, false, context?.signal);
    return {
      items: result.items,
      cursor: { lastCollectedAt: new Date().toISOString(), ...(result.profileName ? { profileName: result.profileName } : {}) },
      billableUnits: 1,
    };
  }

  async health() {
    try { await this.tokenResolver(); return { ok: true }; }
    catch { return { ok: false, message: "SuperGrok 尚未连接" }; }
  }
}
