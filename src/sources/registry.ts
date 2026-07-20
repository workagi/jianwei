import {
  createRuntimeWeRssConnector,
  createRuntimeWebSearchConnector,
  createRuntimeXConnector,
  createRuntimeXaiSearchConnector,
  createWeRssConnector,
  createWebSearchConnector,
  createXConnector,
  createXaiSearchConnector,
} from "@/connectors/factory";
import { TrendRadarMcpClient } from "@/connectors/trendradar/mcp-client";
import { TrendRadarConnector } from "@/connectors/trendradar/trendradar-connector";
import type {
  ConnectorPreview,
  CollectionResult,
  PlatformType,
  WebSearchMonitorConfig,
  WechatAccountMonitorConfig,
  WechatKeywordMonitorConfig,
  XMonitorConfig,
} from "@/connectors/types";
import { isWechatKeywordRuleConfig } from "@/connectors/types";
import { collectWechatKeywordRule, previewWechatKeywordRule } from "@/connectors/wechat/keyword-rule";
import type { SourceProvider, SourceProviderDescriptor, SourceProviderId } from "./types";

const TRENDRADAR_ENDPOINT = process.env.TRENDRADAR_MCP_URL ?? "http://127.0.0.1:3333/mcp";

export const SOURCE_PROVIDER_DESCRIPTORS: readonly SourceProviderDescriptor[] = [
  { id: "x_grok", platform: "x", label: "SuperGrok / X Search", kind: "subscription", supportsPreview: true },
  { id: "x_official", platform: "x", label: "X 官方 API", kind: "api", supportsPreview: true },
  { id: "wechat_werss", platform: "wechat", label: "WeRSS 公众号订阅", kind: "subscription", supportsPreview: true },
  { id: "wechat_keyword", platform: "wechat", label: "公众号关键词规则", kind: "rule", supportsPreview: true },
  { id: "web_brave", platform: "web_search", label: "Brave Search", kind: "api", supportsPreview: true },
  { id: "web_tavily", platform: "web_search", label: "Tavily", kind: "api", supportsPreview: true },
  { id: "web_serper", platform: "web_search", label: "Serper", kind: "api", supportsPreview: true },
  { id: "trendradar", platform: "trendradar", label: "TrendRadar 榜单 / RSS", kind: "sidecar", supportsPreview: false },
] as const;

const descriptorById = new Map(SOURCE_PROVIDER_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]));

export function resolveSourceProviderId(
  platform: PlatformType,
  config: Record<string, unknown>,
): SourceProviderId {
  if (platform === "x") return config.provider === "x_grok" ? "x_grok" : "x_official";
  if (platform === "wechat") return isWechatKeywordRuleConfig(config) ? "wechat_keyword" : "wechat_werss";
  if (platform === "web_search") {
    if (config.provider === "tavily") return "web_tavily";
    if (config.provider === "serper") return "web_serper";
    return "web_brave";
  }
  if (platform === "trendradar") return "trendradar";
  throw new Error(`UNKNOWN_SOURCE_PROVIDER:${platform}`);
}

function descriptor(id: SourceProviderId): SourceProviderDescriptor {
  const found = descriptorById.get(id);
  if (!found) throw new Error(`UNKNOWN_SOURCE_PROVIDER:${id}`);
  return found;
}

type XLike = {
  validate(config: XMonitorConfig): Promise<ConnectorPreview>;
  collect(config: XMonitorConfig, cursor: Record<string, unknown>): Promise<CollectionResult>;
};
type WechatLike = {
  validate(config: WechatAccountMonitorConfig): Promise<ConnectorPreview>;
  collect(config: WechatAccountMonitorConfig, cursor: Record<string, unknown>): Promise<CollectionResult>;
};
type WebLike = {
  validate(config: WebSearchMonitorConfig): Promise<ConnectorPreview>;
  collect(config: WebSearchMonitorConfig, cursor?: Record<string, unknown>): Promise<CollectionResult>;
};

function xProvider(id: Extract<SourceProviderId, `x_${string}`>, connector: XLike): SourceProvider {
  return {
    descriptor: descriptor(id),
    validate: (config) => connector.validate(config as XMonitorConfig),
    collect: (config, cursor) => connector.collect(config as XMonitorConfig, cursor),
  };
}

function wechatProvider(connector: WechatLike): SourceProvider {
  return {
    descriptor: descriptor("wechat_werss"),
    validate: (config) => connector.validate(config as WechatAccountMonitorConfig),
    collect: (config, cursor) => connector.collect(config as WechatAccountMonitorConfig, cursor),
  };
}

function webProvider(id: Extract<SourceProviderId, `web_${string}`>, connector: WebLike): SourceProvider {
  return {
    descriptor: descriptor(id),
    validate: (config) => connector.validate(config as WebSearchMonitorConfig),
    collect: (config, cursor) => connector.collect(config as WebSearchMonitorConfig, cursor),
  };
}

function keywordProvider(): SourceProvider {
  return {
    descriptor: descriptor("wechat_keyword"),
    validate: (config) => previewWechatKeywordRule(config as WechatKeywordMonitorConfig),
    collect: async (config) => ({
      items: await collectWechatKeywordRule(config as WechatKeywordMonitorConfig),
      cursor: { matchedAt: new Date().toISOString() },
    }),
  };
}

function trendRadarProvider(): SourceProvider {
  const connector = new TrendRadarConnector(new TrendRadarMcpClient(TRENDRADAR_ENDPOINT));
  return {
    descriptor: descriptor("trendradar"),
    collect: async () => ({
      items: [...(await connector.latestNews(50)), ...(await connector.latestRss(50, 2))],
      cursor: {},
    }),
  };
}

function webProviderName(id: SourceProviderId): WebSearchMonitorConfig["provider"] {
  if (id === "web_tavily") return "tavily";
  if (id === "web_serper") return "serper";
  return "brave";
}

/** Resolve a provider for the long-running worker (credentials already refreshed into env). */
export function createWorkerSourceProvider(
  platform: PlatformType,
  config: Record<string, unknown>,
): SourceProvider {
  const id = resolveSourceProviderId(platform, config);
  if (id === "x_grok") return xProvider(id, createXaiSearchConnector());
  if (id === "x_official") return xProvider(id, createXConnector());
  if (id === "wechat_werss") return wechatProvider(createWeRssConnector());
  if (id === "wechat_keyword") return keywordProvider();
  if (id === "trendradar") return trendRadarProvider();
  return webProvider(id, createWebSearchConnector(webProviderName(id)));
}

/** Resolve a provider for Next route handlers, reading credentials from the database. */
export async function createRuntimeSourceProvider(
  platform: PlatformType,
  config: Record<string, unknown>,
): Promise<SourceProvider> {
  const id = resolveSourceProviderId(platform, config);
  if (id === "x_grok") return xProvider(id, await createRuntimeXaiSearchConnector());
  if (id === "x_official") return xProvider(id, await createRuntimeXConnector());
  if (id === "wechat_werss") return wechatProvider(await createRuntimeWeRssConnector());
  if (id === "wechat_keyword") return keywordProvider();
  if (id === "trendradar") return trendRadarProvider();
  return webProvider(id, await createRuntimeWebSearchConnector(webProviderName(id)));
}
