import { XConnector } from "./x/x-connector";
import { BraveConnector } from "./web/brave-connector";
import { SerperConnector } from "./web/serper-connector";
import { TavilyConnector } from "./web/tavily-connector";
import { WeRssConnector } from "./wechat/werss-connector";
import type { WebSearchMonitorConfig } from "./types";
import { loadApiCredentials } from "@/db/queries";

/**
 * Single place that maps environment variables to direct-connector instances.
 * Shared by the worker dispatch loop and the /api/monitors/validate route so
 * the credential wiring lives in exactly one file.
 */
const WERSS_DEFAULT = process.env.WERSS_BASE_URL ?? "http://werss:8001";

export function createXConnector(): XConnector {
  return new XConnector(process.env.X_BEARER_TOKEN ?? "");
}

export function createBraveConnector(): BraveConnector {
  return new BraveConnector(process.env.BRAVE_SEARCH_API_KEY ?? "");
}

export function createWebSearchConnector(provider: WebSearchMonitorConfig["provider"] = "brave") {
  if (provider === "tavily") return new TavilyConnector(process.env.TAVILY_API_KEY ?? "");
  if (provider === "serper") return new SerperConnector(process.env.SERPER_API_KEY ?? "");
  return new BraveConnector(process.env.BRAVE_SEARCH_API_KEY ?? "");
}

export function createWeRssConnector(): WeRssConnector {
  return new WeRssConnector(WERSS_DEFAULT, process.env.WERSS_ACCESS_KEY);
}

async function runtimeCredential(key: string): Promise<string | undefined> {
  const envValue = process.env[key]?.trim();
  if (envValue) return envValue;
  if (!process.env.DATABASE_URL) return undefined;
  const rows = await loadApiCredentials();
  return rows.find((row) => row.key === key)?.value?.trim() || undefined;
}

/**
 * Web route handlers run in the Next.js process, not the worker process. The
 * worker refreshes DB-saved credentials into process.env every poll, but web
 * APIs such as `/api/monitors/validate` must read the same DB credentials
 * directly; otherwise the admin preview/save path can 401 while the worker
 * succeeds.
 */
export async function createRuntimeXConnector(): Promise<XConnector> {
  return new XConnector((await runtimeCredential("X_BEARER_TOKEN")) ?? "");
}

export async function createRuntimeBraveConnector(): Promise<BraveConnector> {
  return new BraveConnector((await runtimeCredential("BRAVE_SEARCH_API_KEY")) ?? "");
}

export async function createRuntimeWebSearchConnector(provider: WebSearchMonitorConfig["provider"] = "brave") {
  if (provider === "tavily") return new TavilyConnector((await runtimeCredential("TAVILY_API_KEY")) ?? "");
  if (provider === "serper") return new SerperConnector((await runtimeCredential("SERPER_API_KEY")) ?? "");
  return new BraveConnector((await runtimeCredential("BRAVE_SEARCH_API_KEY")) ?? "");
}

export async function createRuntimeWeRssConnector(): Promise<WeRssConnector> {
  return new WeRssConnector(WERSS_DEFAULT, await runtimeCredential("WERSS_ACCESS_KEY"));
}
