import { z } from "zod";
import type { SourceProviderId } from "@/sources/ids";

export const xMonitorSchema = z.object({
  provider: z.enum(["x_grok", "x_official"]).default("x_official"),
  username: z.string().trim().regex(/^@?[A-Za-z0-9_]{1,15}$/).transform((value) => value.replace(/^@/, "")),
  includeReplies: z.boolean().default(false),
  includeReposts: z.boolean().default(false),
  /** Quote tweets (引用): excluded by default; when on, also store the quoted post for card display. */
  includeQuotes: z.boolean().default(false),
});

export const wechatAccountMonitorSchema = z.object({
  kind: z.literal("account").default("account"),
  articleUrl: z.url().refine((value) => new URL(value).hostname === "mp.weixin.qq.com", "必须是公众号文章链接"),
  provider: z.literal("werss").default("werss"),
  mpId: z.string().trim().optional(),
  mpName: z.string().trim().optional(),
  mpBiz: z.string().trim().optional(),
  mpCover: z.string().trim().optional(),
  mpIntro: z.string().trim().optional(),
});

export const wechatKeywordMonitorSchema = z.object({
  kind: z.literal("keyword_rule"),
  query: z.string().trim().min(1).max(200),
  requiredTerms: z.array(z.string().trim().min(1)).default([]),
  excludedTerms: z.array(z.string().trim().min(1)).default([]),
  matchMode: z.enum(["any", "all"]).default("any"),
  sourceMonitorIds: z.array(z.uuid()).default([]),
  fields: z.array(z.enum(["title", "summary", "content"])).default(["title", "summary", "content"]),
});

export const wechatMonitorSchema = z.preprocess((value) => {
  if (value && typeof value === "object" && "kind" in value && (value as { kind?: unknown }).kind === "keyword_rule") {
    return value;
  }
  return { ...(value as Record<string, unknown>), kind: "account" };
}, z.discriminatedUnion("kind", [wechatAccountMonitorSchema, wechatKeywordMonitorSchema]));

export const webSearchMonitorSchema = z.object({
  provider: z.enum(["brave", "tavily", "serper"]).default("brave"),
  query: z.string().trim().min(2).max(200),
  exactPhrases: z.array(z.string().trim().min(1)).default([]),
  excludedTerms: z.array(z.string().trim().min(1)).default([]),
  includeDomains: z.array(z.string().trim().min(1)).default([]),
  excludeDomains: z.array(z.string().trim().min(1)).default([]),
  language: z.string().trim().optional(),
  country: z.string().trim().optional(),
  resultType: z.enum(["web", "news", "both"]).default("both"),
});

export type PlatformType = "x" | "wechat" | "web_search" | "trendradar";
export type XMonitorConfig = z.infer<typeof xMonitorSchema>;
export type WechatMonitorConfig = z.infer<typeof wechatMonitorSchema>;
export type WechatAccountMonitorConfig = z.infer<typeof wechatAccountMonitorSchema>;
export type WechatKeywordMonitorConfig = z.infer<typeof wechatKeywordMonitorSchema>;
export type WebSearchMonitorConfig = z.infer<typeof webSearchMonitorSchema>;

export function isWechatKeywordRuleConfig(config: unknown): config is WechatKeywordMonitorConfig {
  return Boolean(config && typeof config === "object" && (config as { kind?: unknown }).kind === "keyword_rule");
}

export interface MonitorConfigMap {
  x: XMonitorConfig;
  wechat: WechatMonitorConfig;
  web_search: WebSearchMonitorConfig;
}

export interface XQuotedPost {
  authorName?: string;
  authorHandle?: string;
  text: string;
  url?: string;
}

export interface NormalizedItem {
  platform: PlatformType;
  /** Stable collector identity, independent from the reader's broad platform tab. */
  sourceProvider?: SourceProviderId;
  upstreamId: string;
  canonicalUrl: string;
  authorId?: string;
  authorName?: string;
  authorHandle?: string;
  avatarUrl?: string;
  title?: string;
  text: string;
  contentHtml?: string;
  /** Which WeChat full-text channel produced contentHtml. */
  contentProvider?: "werss" | "direct" | "wechat_download_api";
  /** Full-text retrieval outcome; independent from list/article collection. */
  contentFetchStatus?: "success" | "failed";
  contentFetchError?: string;
  contentFetchedAt?: Date;
  /** For X quote tweets: the nested quoted post shown under the author's commentary. */
  quotedPost?: XQuotedPost;
  imageUrls: string[];
  publishedAt: Date;
  raw: unknown;
}

/** Encode an X quote into contentHtml so it survives DB storage without a migration. */
export function encodeXQuotedPost(quote: XQuotedPost): string {
  return JSON.stringify({
    type: "x_quote",
    authorName: quote.authorName ?? "",
    authorHandle: quote.authorHandle ?? "",
    text: quote.text,
    url: quote.url ?? "",
  });
}

/** Decode X quote payload stored in contentHtml. */
export function decodeXQuotedPost(contentHtml?: string | null): XQuotedPost | undefined {
  if (!contentHtml?.trim()) return undefined;
  try {
    const parsed = JSON.parse(contentHtml) as {
      type?: unknown;
      authorName?: unknown;
      authorHandle?: unknown;
      text?: unknown;
      url?: unknown;
    };
    if (parsed.type !== "x_quote" || typeof parsed.text !== "string" || !parsed.text.trim()) return undefined;
    return {
      authorName: typeof parsed.authorName === "string" && parsed.authorName.trim() ? parsed.authorName.trim() : undefined,
      authorHandle: typeof parsed.authorHandle === "string" && parsed.authorHandle.trim()
        ? parsed.authorHandle.trim().replace(/^@/, "")
        : undefined,
      text: parsed.text.trim(),
      url: typeof parsed.url === "string" && parsed.url.trim() ? parsed.url.trim() : undefined,
    };
  } catch {
    return undefined;
  }
}

export interface ConnectorPreview {
  displayName: string;
  avatarUrl?: string;
  items: NormalizedItem[];
  warning?: string;
  configPatch?: Record<string, unknown>;
}

export interface CollectionResult {
  items: NormalizedItem[];
  cursor: Record<string, unknown>;
  billableUnits?: number;
}

export interface CollectContext {
  /** Cancels every network request that belongs to one worker run. */
  signal?: AbortSignal;
  runId?: string;
  deadline?: Date;
}

export interface Connector<K extends keyof MonitorConfigMap> {
  validate(config: MonitorConfigMap[K]): Promise<ConnectorPreview>;
  collect(
    config: MonitorConfigMap[K],
    cursor: Record<string, unknown>,
    context?: CollectContext,
  ): Promise<CollectionResult>;
  health(): Promise<{ ok: boolean; message?: string }>;
}
