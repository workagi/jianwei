import { z } from "zod";

export const xMonitorSchema = z.object({
  username: z.string().trim().regex(/^@?[A-Za-z0-9_]{1,15}$/).transform((value) => value.replace(/^@/, "")),
  includeReplies: z.boolean().default(false),
  includeReposts: z.boolean().default(false),
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

export interface NormalizedItem {
  platform: PlatformType;
  upstreamId: string;
  canonicalUrl: string;
  authorId?: string;
  authorName?: string;
  authorHandle?: string;
  title?: string;
  text: string;
  contentHtml?: string;
  imageUrls: string[];
  publishedAt: Date;
  raw: unknown;
}

export interface ConnectorPreview {
  displayName: string;
  avatarUrl?: string;
  items: NormalizedItem[];
  warning?: string;
}

export interface CollectionResult {
  items: NormalizedItem[];
  cursor: Record<string, unknown>;
  billableUnits?: number;
}

export interface Connector<K extends keyof MonitorConfigMap> {
  validate(config: MonitorConfigMap[K]): Promise<ConnectorPreview>;
  collect(config: MonitorConfigMap[K], cursor: Record<string, unknown>): Promise<CollectionResult>;
  health(): Promise<{ ok: boolean; message?: string }>;
}
